import { describe, expect, it } from 'vitest'
import { isEditable, shouldFocusComposer } from '../src/renderer/lib/composer-focus'
import { MAX_IMAGE_FILE_BYTES, MAX_PROMPT_IMAGES, checkImageFile, pickImageFiles } from '../src/renderer/lib/images'
import { PromptQueues, acceptsInput, restoreComposer, submitMode } from '../src/renderer/lib/prompt-queue'
import { withTurnEnd, type SessionData } from '../src/renderer/store'

/** A deliver that records prompts and settles each one when the test says its turn ended. */
function harness() {
  const sent: string[] = []
  const settle: (() => void)[] = []
  let changes = 0
  const q = new PromptQueues(
    (_id, p, started) => {
      sent.push(p.text)
      // Main sends it straight away (nothing else of the session in flight).
      started()
      return new Promise<void>((resolve) => settle.push(resolve))
    },
    () => changes++
  )
  const endTurn = async () => {
    settle.shift()?.()
    await new Promise((r) => setTimeout(r, 0))
  }
  return { q, sent, endTurn, changes: () => changes }
}

describe('submitMode', () => {
  it('sends when ready, injects mid-turn only on agents that take it, and queues otherwise', () => {
    expect(submitMode('ready', false, 0, 0)).toBe('sent')
    expect(submitMode('busy', false, 0, 1)).toBe('queued')
    expect(submitMode('busy', true, 0, 1)).toBe('injected')
    expect(submitMode('starting', true, 0, 0)).toBe('queued')
    // Order wins: with older messages waiting, a new one waits too.
    expect(submitMode('ready', false, 1, 0)).toBe('queued')
    expect(submitMode('busy', true, 1, 1)).toBe('queued')
    expect(submitMode('stopped', false, 0, 0)).toBe('refused')
    expect(submitMode('error', true, 0, 0)).toBe('refused')
  })
  it('takes input while starting, ready or busy', () => {
    expect(['starting', 'ready', 'busy', 'stopped', 'error'].map((s) => acceptsInput(s as never))).toEqual([true, true, true, false, false])
  })
})

describe('PromptQueues', () => {
  it('delivers messages sent during a turn one at a time, in order, when the session is ready again', async () => {
    const { q, sent, endTurn } = harness()
    expect(q.submit('s', 'ready', false, 'first')).toBe('sent')
    q.stateChanged('s', 'busy')
    expect(q.submit('s', 'busy', false, 'second')).toBe('queued')
    expect(q.submit('s', 'busy', false, 'third')).toBe('queued')
    expect(q.list('s').map((p) => p.text)).toEqual(['second', 'third'])
    expect(sent).toEqual(['first'])

    // Ready arrives before the prompt settles: nothing goes out while ours still runs.
    q.stateChanged('s', 'ready')
    expect(sent).toEqual(['first'])
    await endTurn()
    expect(sent).toEqual(['first', 'second'])
    expect(q.list('s').map((p) => p.text)).toEqual(['third'])

    // The prompt settles first, then the session turns ready.
    q.stateChanged('s', 'busy')
    await endTurn()
    expect(sent).toEqual(['first', 'second'])
    q.stateChanged('s', 'ready')
    expect(sent).toEqual(['first', 'second', 'third'])
    expect(q.list('s')).toEqual([])
  })

  it('lets a queued message be removed before it is sent', async () => {
    const { q, sent, endTurn, changes } = harness()
    q.submit('s', 'ready', false, 'first')
    q.stateChanged('s', 'busy')
    q.submit('s', 'busy', false, 'drop me')
    q.submit('s', 'busy', false, 'keep me', ['data:image/png;base64,AAAA'])
    const before = changes()
    expect(q.remove('s', q.list('s')[0]!.id)).toBe(true)
    expect(changes()).toBe(before + 1)
    expect(q.remove('s', 999)).toBe(false)
    q.stateChanged('s', 'ready')
    await endTurn()
    expect(sent).toEqual(['first', 'keep me'])
  })

  it('injects into the running turn on agents that take mid-turn input', () => {
    const { q, sent } = harness()
    q.submit('s', 'ready', true, 'first')
    q.stateChanged('s', 'busy')
    expect(q.submit('s', 'busy', true, 'more')).toBe('injected')
    expect(sent).toEqual(['first', 'more'])
    expect(q.list('s')).toEqual([])
  })

  it('holds messages sent while the agent starts, and drops them with the session', () => {
    const { q, sent } = harness()
    q.stateChanged('a', 'starting')
    q.submit('a', 'starting', false, 'early')
    q.stateChanged('a', 'ready')
    expect(sent).toEqual(['early'])

    q.submit('b', 'busy', false, 'lost')
    q.drop('b')
    q.stateChanged('b', 'ready')
    expect(sent).toEqual(['early'])
    expect(q.submit('c', 'stopped', false, 'no')).toBe('refused')
    expect(q.list('c')).toEqual([])
  })

  it('takes every waiting message out on an interrupt, so none goes out when the interrupted turn ends', async () => {
    const { q, sent, endTurn, changes } = harness()
    q.submit('s', 'ready', false, 'running')
    q.stateChanged('s', 'busy')
    q.submit('s', 'busy', false, 'one')
    q.submit('s', 'busy', false, 'two', ['data:image/png;base64,AAAA'])
    const before = changes()
    expect(q.takeAll('s').map((p) => [p.text, p.images.length])).toEqual([
      ['one', 0],
      ['two', 1]
    ])
    expect(changes()).toBe(before + 1)
    expect(q.list('s')).toEqual([])
    // The cancelled turn settles and the session turns ready: nothing follows it.
    await endTurn()
    q.stateChanged('s', 'ready')
    expect(sent).toEqual(['running'])
    expect(q.takeAll('s')).toEqual([])
  })

  it('keeps a message main holds behind another prompt listed and removable until it goes out', async () => {
    const goOut: (() => void)[] = []
    const settle: ((e?: Error) => void)[] = []
    const withdrawn: number[] = []
    const heldAtFailure: boolean[] = []
    const q: PromptQueues = new PromptQueues(
      (id, p, started) => {
        goOut.push(started)
        return new Promise<void>((resolve, reject) => settle.push((e) => (e ? (heldAtFailure.push(q.isHeld(id, p.id)), reject(e)) : resolve())))
      },
      () => undefined,
      (_s, id) => void withdrawn.push(id)
    )
    // Sent while main runs an AI review prompt: main holds it.
    expect(q.submit('s', 'ready', false, 'held')).toBe('sent')
    const snapshot = q.list('s')
    expect(snapshot.map((p) => p.text)).toEqual(['held'])
    expect(q.list('s')).toBe(snapshot)
    q.stateChanged('s', 'busy')
    q.submit('s', 'busy', false, 'queued')
    expect(q.list('s').map((p) => p.text)).toEqual(['held', 'queued'])
    // It goes out: no longer listed.
    goOut.shift()!()
    expect(q.list('s').map((p) => p.text)).toEqual(['queued'])
    settle.shift()!()
    q.stateChanged('s', 'ready')
    await new Promise((r) => setTimeout(r, 0))
    // The next one is held again, and the user removes it before it goes out.
    const id = q.list('s')[0]!.id
    expect(q.isHeld('s', id)).toBe(true)
    expect(q.remove('s', id)).toBe(true)
    expect(withdrawn).toEqual([id])
    expect(q.list('s')).toEqual([])
    settle.shift()!(new Error('withdrawn'))
    await new Promise((r) => setTimeout(r, 0))
    // Removed by the user: not held any more when main's refusal comes back, so it is not offered again.
    expect(heldAtFailure).toEqual([false])
  })

  it('keeps going after a prompt fails', async () => {
    const sent: string[] = []
    const q = new PromptQueues(async (_id, p) => {
      sent.push(p.text)
      throw new Error('boom')
    })
    q.stateChanged('s', 'busy')
    q.submit('s', 'busy', false, 'one')
    q.submit('s', 'busy', false, 'two')
    q.stateChanged('s', 'ready')
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toEqual(['one', 'two'])
  })
})

describe('restoreComposer', () => {
  it('puts the messages back ahead of the draft, joined by blank lines, with their images first', () => {
    const recovered = [
      { text: 'one ', images: ['a'] },
      { text: '', images: ['b'] },
      { text: 'two', images: [] }
    ]
    expect(restoreComposer({ text: 'typing', images: ['c'] }, recovered, 10)).toEqual({ text: 'one\n\ntwo\n\ntyping', images: ['a', 'b', 'c'] })
    expect(restoreComposer({ text: '  ', images: [] }, recovered, 2)).toEqual({ text: 'one\n\ntwo', images: ['a', 'b'] })
  })
})

describe('turn end divider', () => {
  const data = (items: SessionData['items']): SessionData => ({ view: {} as SessionData['view'], items, monitor: {} })
  it('adds one divider when several prompts settle together', () => {
    let n = 0
    const once = withTurnEnd(data([{ id: 1, kind: 'agent', text: 'hi' }]), 'end_turn', () => ++n + 10)
    expect(once.items.at(-1)).toEqual({ id: 11, kind: 'turnEnd', stopReason: 'end_turn' })
    expect(withTurnEnd(once, 'end_turn', () => 99)).toBe(once)
    expect(withTurnEnd(once, 'cancelled', () => 99).items).toHaveLength(3)
  })
  it('cancels the tool calls a stopped turn left unfinished, and keeps them on a normal end', () => {
    const tools = data([
      { id: 1, kind: 'tool', toolCallId: 'a', title: 'Read', status: 'in_progress' },
      { id: 2, kind: 'tool', toolCallId: 'b', title: 'Edit', status: 'completed' }
    ])
    const stopped = withTurnEnd(tools, 'cancelled', () => 3)
    expect(stopped.items.map((i) => (i.kind === 'tool' ? i.status : i.kind))).toEqual(['cancelled', 'completed', 'turnEnd'])
    expect(withTurnEnd(tools, 'end_turn', () => 3).items[0]).toMatchObject({ status: 'in_progress' })
  })
})

describe('pasted images', () => {
  it('checks type and encoded size before reading a file', () => {
    expect(checkImageFile({ type: 'image/PNG', size: 10 })).toBeNull()
    expect(checkImageFile({ type: 'image/tiff', size: 10 })).toBe('type')
    expect(checkImageFile({ type: 'image/jpeg', size: MAX_IMAGE_FILE_BYTES + 1 })).toBe('size')
    // Base64 of the largest accepted file still fits Claude's 5 MB per image.
    expect(Math.ceil(MAX_IMAGE_FILE_BYTES / 3) * 4).toBeLessThanOrEqual(5 * 1024 * 1024)
  })
  it('keeps the per-message count, counting the images already attached', () => {
    const png = { type: 'image/png', size: 1 }
    const pick = pickImageFiles([png, { type: 'image/bmp', size: 1 }, png, png], MAX_PROMPT_IMAGES - 2)
    expect(pick.accepted).toHaveLength(2)
    expect(pick.rejected.map((r) => r.reason)).toEqual(['type', 'count'])
  })
})

describe('composer focus', () => {
  const off = { active: false, enabled: true }
  const on = { active: true, enabled: true }
  it('takes the focus when its chat comes on screen', () => {
    expect(shouldFocusComposer(off, on, false)).toBe(true)
    // Even from the sidebar or another input: picking the session means typing in it.
    expect(shouldFocusComposer(off, on, true)).toBe(true)
    expect(shouldFocusComposer(off, { active: true, enabled: false }, false)).toBe(false)
    expect(shouldFocusComposer(on, off, false)).toBe(false)
  })
  it('takes it when it opens while on screen, unless the user types elsewhere', () => {
    const closed = { active: true, enabled: false }
    expect(shouldFocusComposer(closed, on, false)).toBe(true)
    expect(shouldFocusComposer(closed, on, true)).toBe(false)
    // Already on screen and open: re-renders never steal the focus back.
    expect(shouldFocusComposer(on, on, false)).toBe(false)
  })
  it('knows which elements take typing', () => {
    expect(isEditable(null)).toBe(false)
    expect(isEditable({ tagName: 'TEXTAREA' } as Element)).toBe(true)
    expect(isEditable({ tagName: 'INPUT' } as Element)).toBe(true)
    expect(isEditable({ tagName: 'DIV', isContentEditable: true } as unknown as Element)).toBe(true)
    expect(isEditable({ tagName: 'BUTTON' } as Element)).toBe(false)
  })
})
