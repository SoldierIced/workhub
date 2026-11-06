import type { IpcMainInvokeEvent } from 'electron'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { emptyConfig, type ListenSummaryResult, type WorkhubConfig } from '@workhub/core'
import type { ListenSummaryRequest } from '@workhub/adapters/listen-summary'
import { listenConfigDir, registerListenIpc } from '../src/main/listen-ipc'
import { listenPhase, toggleListen } from '../src/renderer/lib/listen'
import { isLongMessage, LONG_MESSAGE_CHARS, LONG_MESSAGE_LINES } from '../src/renderer/lib/longMessage'
import { pickVoice } from '../src/renderer/lib/readAloud'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const config: WorkhubConfig = {
  ...emptyConfig(),
  accounts: [
    { id: 'work', agentId: 'claude', name: 'Work', configDir: '/h/.claude-work' },
    { id: 'cx', agentId: 'codex', name: 'Codex', configDir: '/h/.codex-x' }
  ],
  options: { ...emptyConfig().options, listenModel: 'claude-haiku-4-5' } as WorkhubConfig['options']
}

function setup(summarize: (r: ListenSummaryRequest) => Promise<ListenSummaryResult>, sessions: Record<string, { agentId: string; accountId: string | null }> = { s1: { agentId: 'claude', accountId: 'work' } }, log: (message: string) => void = () => undefined) {
  const handlers = new Map<string, Handler>()
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  const fake = vi.fn(summarize)
  registerListenIpc(
    { handle: (c, h) => handlers.set(c, h as Handler), on: (c, l) => listeners.set(c, l as (event: unknown, ...args: unknown[]) => void) },
    { summarize: fake, config: async () => config, session: (id) => sessions[id] ?? null, home: '/h', env: {}, log }
  )
  const invoke = (...a: unknown[]) => handlers.get('listen:summarize')!({} as IpcMainInvokeEvent, ...a) as Promise<ListenSummaryResult>
  const cancel = (id: unknown) => listeners.get('listen:cancel')!({}, id)
  return { invoke, cancel, fake }
}

describe('listen:summarize', () => {
  it('summarizes with the configured model on the session’s Claude account', async () => {
    const { invoke, fake } = setup(async () => ({ ok: true, summary: 'The tests pass.', costUsd: 0.0003 }))
    expect(await invoke('r1', 's1', 'A long **reply**')).toEqual({ ok: true, summary: 'The tests pass.', costUsd: 0.0003 })
    expect(fake).toHaveBeenCalledWith(expect.objectContaining({ text: 'A long **reply**', model: 'claude-haiku-4-5', configDir: resolve('/h/.claude-work') }))
  })

  it('passes a failure through, and turns a thrown error into one', async () => {
    expect(await setup(async () => ({ ok: false, failure: 'timeout', error: 'Timed out after 45 s' })).invoke('r1', 's1', 'x')).toEqual({ ok: false, failure: 'timeout', error: 'Timed out after 45 s' })
    expect(
      await setup(async () => {
        throw new Error('spawn failed')
      }).invoke('r1', 's1', 'x')
    ).toEqual({ ok: false, failure: 'failed', error: 'spawn failed' })
  })

  it('logs why a summary failed, but not a cancel', async () => {
    const log = vi.fn()
    await setup(async () => ({ ok: false, failure: 'noAccount', error: 'Not logged in' }), undefined, log).invoke('r1', 's1', 'x')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('noAccount'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Not logged in'))
    log.mockClear()
    await setup(async () => ({ ok: false, failure: 'cancelled', error: 'Cancelled.' }), undefined, log).invoke('r1', 's1', 'x')
    await setup(async () => ({ ok: true, summary: 'ok' }), undefined, log).invoke('r1', 's1', 'x')
    expect(log).not.toHaveBeenCalled()
  })

  it('refuses a malformed request', async () => {
    const { invoke, fake } = setup(async () => ({ ok: true, summary: 'x' }))
    await expect(invoke('r1', 's1', '   ')).rejects.toThrow()
    await expect(invoke('', 's1', 'x')).rejects.toThrow()
    await expect(invoke('r1', 42, 'x')).rejects.toThrow()
    expect(fake).not.toHaveBeenCalled()
  })

  it('cancel aborts the running summary', async () => {
    let seen: AbortSignal | undefined
    const { invoke, cancel } = setup(
      (r) =>
        new Promise((done) => {
          seen = r.signal
          r.signal?.addEventListener('abort', () => done({ ok: false, failure: 'cancelled', error: 'Cancelled.' }))
        })
    )
    const pending = invoke('r9', 's1', 'x')
    await vi.waitFor(() => expect(seen).toBeDefined())
    cancel('r9')
    expect(seen!.aborted).toBe(true)
    expect(await pending).toMatchObject({ failure: 'cancelled' })
  })
})

describe('listenConfigDir', () => {
  it('uses the session’s Claude account, else Claude’s default folder', () => {
    expect(listenConfigDir(config, { agentId: 'claude', accountId: 'work' }, '/h', {})).toBe(resolve('/h/.claude-work'))
    // A Codex session has no Claude login of its own; nor does an unknown session.
    expect(listenConfigDir(config, { agentId: 'codex', accountId: 'cx' }, '/h', {})).toBe(resolve('/h/.claude'))
    expect(listenConfigDir(config, null, '/h', { CLAUDE_CONFIG_DIR: '/h/.claude-env' })).toBe(resolve('/h/.claude-env'))
  })
})

describe('the Listen button', () => {
  it('shows the phase of its own message only', () => {
    const id = 'listen:s1:4'
    expect(listenPhase(id, null, { id: null, paused: false })).toBe('idle')
    expect(listenPhase(id, id, { id: null, paused: false })).toBe('summarizing')
    expect(listenPhase(id, null, { id, paused: false })).toBe('playing')
    expect(listenPhase(id, null, { id, paused: true })).toBe('paused')
    expect(listenPhase(id, 'listen:s1:5', { id: 'reply:s1', paused: false })).toBe('idle')
  })

  it('starts only from idle; playing and paused pause and resume instead', () => {
    const start = vi.fn()
    toggleListen('idle', start)
    toggleListen('playing', start)
    toggleListen('paused', start)
    expect(start).toHaveBeenCalledOnce()
  })
})

describe('pickVoice', () => {
  const v = (name: string, lang: string, extra: { default?: boolean; localService?: boolean } = {}) => ({ name, lang, default: false, localService: false, ...extra })
  const voices = [v('Samantha', 'en-US', { default: true }), v('Remote es', 'es-ES'), v('Paulina', 'es_MX', { localService: true }), v('Monica', 'es-ES')]

  it('takes the named voice, else a voice of the app language, local first', () => {
    expect(pickVoice(voices, 'Monica', 'en')?.name).toBe('Monica')
    expect(pickVoice(voices, '', 'es')?.name).toBe('Paulina')
    expect(pickVoice(voices, '', 'en')?.name).toBe('Samantha')
    expect(pickVoice(voices, 'Missing', 'es')?.name).toBe('Paulina')
    expect(pickVoice(voices, '', 'fr')).toBeUndefined()
    expect(pickVoice(voices, '')).toBeUndefined()
  })
})

describe('isLongMessage', () => {
  it('collapses messages over the line or character limit', () => {
    expect(isLongMessage('short')).toBe(false)
    expect(isLongMessage('x'.repeat(LONG_MESSAGE_CHARS))).toBe(false)
    expect(isLongMessage('x'.repeat(LONG_MESSAGE_CHARS + 1))).toBe(true)
    expect(isLongMessage(Array(LONG_MESSAGE_LINES).fill('line').join('\n'))).toBe(false)
    expect(isLongMessage(Array(LONG_MESSAGE_LINES + 1).fill('line').join('\n'))).toBe(true)
    // A pasted crash report: one huge line with no spaces.
    expect(isLongMessage(JSON.stringify({ trace: 'a'.repeat(5000) }))).toBe(true)
  })
})
