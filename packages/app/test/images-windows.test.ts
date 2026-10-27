import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BrowserWindow } from 'electron'
import { cachePastedImage, cachePastedImages, decodeImageDataUrl, pastedImageName } from '../src/main/pasted-images'
import {
  boundsOnScreen,
  readSavedWindows,
  SESSION_WINDOW_SIZE,
  SessionWindows,
  type SavedSessionWindows,
  type WindowBounds
} from '../src/main/session-windows'
import { TerminalScrollback } from '../src/renderer/lib/terminal-scrollback'
import { attachOutput, onChanged, onEvent, onRemoved, replayItems, seedSession, sessionSnapshot } from '../src/renderer/store'
import type { SessionView } from '../src/shared/api'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const pngUrl = `data:image/png;base64,${PNG.toString('base64')}`

// --- Pasted images ------------------------------------------------------------------------------

describe('pasted images', () => {
  it('decodes accepted image data URLs only', () => {
    expect(decodeImageDataUrl(pngUrl)).toEqual({ mediaType: 'image/png', bytes: PNG })
    expect(decodeImageDataUrl('data:image/JPEG;base64,/9j/')?.mediaType).toBe('image/jpeg')
    expect(decodeImageDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull()
    expect(decodeImageDataUrl('data:text/plain;base64,aGk=')).toBeNull()
    expect(decodeImageDataUrl('https://example.com/a.png')).toBeNull()
    expect(decodeImageDataUrl(42)).toBeNull()
  })

  it('names an image after its content', () => {
    const name = pastedImageName(PNG, 'image/png')
    expect(name).toMatch(/^[0-9a-f]{24}\.png$/)
    expect(pastedImageName(PNG, 'image/jpeg')).toBe(name.replace('.png', '.jpg'))
    expect(pastedImageName(Buffer.from('other'), 'image/png')).not.toBe(name)
  })

  it('writes each image once to the cache folder', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'wh-pasted-')), 'pasted-images')
    const first = await cachePastedImage(dir, pngUrl)
    expect(first).toBe(join(dir, pastedImageName(PNG, 'image/png')))
    expect(readFileSync(first!)).toEqual(PNG)
    expect(await cachePastedImage(dir, pngUrl)).toBe(first)
    expect(readdirSync(dir)).toEqual([pastedImageName(PNG, 'image/png')])
    expect(await cachePastedImages(dir, [pngUrl, 'data:text/plain;base64,aGk=', null])).toEqual([first, null, null])
    expect(await cachePastedImages(dir, 'not a list')).toEqual([])
  })
})

// --- Replayed images and terminal output in the renderer store ----------------------------------

describe('chat images and terminal output in the store', () => {
  let n = 0
  const next = () => ++n

  it('shows replayed images that could be read back, else their count', () => {
    const items = replayItems(
      [
        { kind: 'user', text: 'look', images: 2, imageData: [{ mediaType: 'image/png', data: 'AAA' }] },
        { kind: 'user', text: 'old', images: 1 }
      ],
      next
    )
    expect(items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'look', images: ['data:image/png;base64,AAA'] }),
      expect.objectContaining({ kind: 'user', text: 'old', images: 1 })
    ])
  })

  const view = (id: string): SessionView => ({ id, state: 'ready', cwd: '/tmp/x', startedAt: 1 }) as SessionView

  it('gives a terminal view everything its channel printed, also when it mounts later', () => {
    onChanged(view('t1'))
    onEvent({ sessionId: 't1:console', type: 'output', data: 'one\r\n' })
    const first: string[] = []
    const detach = attachOutput('t1:console', { write: (d) => first.push(d) })
    onEvent({ sessionId: 't1:console', type: 'output', data: 'two\r\n' })
    detach()
    onEvent({ sessionId: 't1:console', type: 'output', data: 'three\r\n' })
    expect(first.join('')).toBe('one\r\ntwo\r\n')
    // A view mounted again (the session came back from its own window) starts from all of it.
    const again: string[] = []
    attachOutput('t1:console', { write: (d) => again.push(d) })()
    expect(again.join('')).toBe('one\r\ntwo\r\nthree\r\n')
    expect(sessionSnapshot('t1')?.terminals).toEqual({ 't1:console': 'one\r\ntwo\r\nthree\r\n' })
    onRemoved('t1')
  })

  it('starts a session window terminal from the snapshot, replacing what it got before', () => {
    onChanged(view('t2'))
    // Output that reached the new window before its snapshot is in the snapshot too.
    onEvent({ sessionId: 't2:shell', type: 'output', data: 'late' })
    const written: string[] = []
    let resets = 0
    attachOutput('t2:shell', { write: (d) => written.push(d), reset: () => resets++ })
    seedSession('t2', { items: [], monitor: {}, terminals: { 't2:shell': 'early\r\nlate', 'other:shell': 'not mine' } })
    expect(resets).toBe(1)
    expect(written).toEqual(['late', 'early\r\nlate'])
    expect(sessionSnapshot('t2')?.terminals).toEqual({ 't2:shell': 'early\r\nlate' })
    onRemoved('t2')
    expect(sessionSnapshot('t2')).toBeNull()
  })
})

describe('terminal scrollback', () => {
  it('drops whole chunks, oldest first, past its limit', () => {
    const s = new TerminalScrollback(10)
    s.append('a:console', '12345')
    s.append('a:console', '6789')
    s.append('a:console', 'ab')
    expect(s.text('a:console')).toBe('6789ab')
    s.append('a:console', 'x'.repeat(20))
    // The newest chunk stays even when it alone is past the limit.
    expect(s.text('a:console')).toBe('x'.repeat(20))
  })

  it('lists, replaces and drops the channels of one session', () => {
    const s = new TerminalScrollback()
    s.append('a:console', 'c')
    s.append('a:shell', 's')
    s.append('ab:console', 'other')
    expect(s.ofSession('a')).toEqual({ 'a:console': 'c', 'a:shell': 's' })
    s.replace('a:shell', 'new')
    expect(s.text('a:shell')).toBe('new')
    s.dropSession('a')
    expect(s.ofSession('a')).toEqual({})
    expect(s.text('ab:console')).toBe('other')
  })
})

// --- Session windows across launches -----------------------------------------------------------

class FakeWindow extends EventEmitter {
  destroyed = false
  focused = 0
  readonly webContents = { id: Math.random(), send: () => undefined, isDestroyed: () => this.destroyed }
  constructor(
    readonly hash: string,
    public bounds: WindowBounds
  ) {
    super()
  }
  isDestroyed() {
    return this.destroyed
  }
  getBounds() {
    return this.bounds
  }
  isMinimized() {
    return false
  }
  restore() {}
  show() {}
  focus() {
    this.focused++
  }
  close() {
    this.destroyed = true
    this.emit('closed')
  }
  moveTo(b: WindowBounds) {
    this.bounds = b
    this.emit('move')
  }
}

function harness(saved: SavedSessionWindows = { sessions: [] }) {
  let stored: SavedSessionWindows = saved
  let flushed = 0
  const open = new Map<string, string>([
    ['s1', 'agent-1'],
    ['s2', 'agent-2']
  ])
  const created: { hash: string; bounds?: WindowBounds; win: FakeWindow }[] = []
  const deferred: (() => void)[] = []
  const windows = new SessionWindows({
    create: (hash, _size, bounds) => {
      const win = new FakeWindow(hash, bounds ?? { x: 0, y: 0, width: 980, height: 760 })
      created.push({ hash, bounds, win })
      return win as unknown as BrowserWindow
    },
    mainWindow: () => null,
    showMain: () => undefined,
    exists: (id) => open.has(id),
    identityOf: (id) => open.get(id),
    store: {
      load: () => stored,
      save: (v) => {
        stored = v
      },
      flush: () => flushed++
    },
    defer: (fn) => deferred.push(fn)
  })
  const runDeferred = () => deferred.splice(0).forEach((fn) => fn())
  return { windows, created, open, runDeferred, stored: () => stored, flushed: () => flushed }
}

describe('session windows across launches', () => {
  it('remembers a detached session and its bounds by identity, and forgets it when docked or closed', () => {
    const h = harness()
    h.windows.open('s1')
    h.created[0]!.win.moveTo({ x: 40, y: 50, width: 800, height: 600 })
    expect(h.stored()).toEqual({ sessions: [{ key: 'agent-1', bounds: { x: 40, y: 50, width: 800, height: 600 } }] })
    h.windows.dock('s1')
    expect(h.stored()).toEqual({ sessions: [] })
    h.windows.open('s2')
    h.created[1]!.win.close()
    expect(h.windows.remembered()).toEqual([])
  })

  it('keeps the windows open at quit remembered', () => {
    const h = harness()
    h.windows.open('s1')
    h.windows.suspend()
    h.created[0]!.win.close()
    expect(h.windows.remembered()).toEqual(['agent-1'])
    expect(h.flushed()).toBe(1)
  })

  it('reopens a remembered session in its window, at its old place, once the session is open again', () => {
    const bounds = { x: 100, y: 120, width: 700, height: 500 }
    const h = harness({ sessions: [{ key: 'agent-1', bounds }, { key: 'gone' }] })
    h.windows.sessionChanged('s1')
    h.windows.sessionChanged('s1')
    expect(h.created).toHaveLength(0)
    h.runDeferred()
    expect(h.created).toEqual([expect.objectContaining({ hash: '#session?id=s1', bounds })])
    expect(h.windows.detached()).toEqual(['s1'])
    // Later changes do not open it again or steal the focus.
    h.windows.sessionChanged('s1')
    h.runDeferred()
    expect(h.created).toHaveLength(1)
    expect(h.created[0]!.win.focused).toBe(0)
    // A session that was not detached stays in the main window.
    h.windows.sessionChanged('s2')
    h.runDeferred()
    expect(h.created).toHaveLength(1)
  })

  it('moves the remembered entry when the session identity arrives later', () => {
    const h = harness()
    h.open.set('s1', 's1')
    h.windows.open('s1')
    h.open.set('s1', 'agent-late')
    h.windows.sessionChanged('s1')
    expect(h.windows.remembered()).toEqual(['agent-late'])
  })

  it('reads the stored file defensively', () => {
    expect([...readSavedWindows({ sessions: [{ key: 'a', bounds: { x: 1, y: 2, width: 3, height: 4 } }, { key: 'b', bounds: { x: 'no' } }, { nokey: 1 }, 'junk'] })]).toEqual([
      ['a', { x: 1, y: 2, width: 3, height: 4 }],
      ['b', undefined]
    ])
    expect(readSavedWindows(null).size).toBe(0)
    expect(readSavedWindows({ sessions: 'x' }).size).toBe(0)
  })

  it('opens at the default place when the old one is off every screen', () => {
    const screens = [{ x: 0, y: 25, width: 1440, height: 875 }]
    expect(boundsOnScreen({ x: 100, y: 100, width: 800, height: 600 }, screens, SESSION_WINDOW_SIZE)).toEqual({ x: 100, y: 100, width: 800, height: 600 })
    // A screen that was unplugged.
    expect(boundsOnScreen({ x: 2000, y: 100, width: 800, height: 600 }, screens, SESSION_WINDOW_SIZE)).toBeUndefined()
    // The title bar above the screen cannot be reached.
    expect(boundsOnScreen({ x: 100, y: -300, width: 800, height: 600 }, screens, SESSION_WINDOW_SIZE)).toBeUndefined()
    // Too small: grown to the window's minimum.
    expect(boundsOnScreen({ x: 10, y: 30, width: 100, height: 100 }, screens, SESSION_WINDOW_SIZE)).toEqual({ x: 10, y: 30, width: 560, height: 420 })
    expect(boundsOnScreen(undefined, screens, SESSION_WINDOW_SIZE)).toBeUndefined()
  })
})
