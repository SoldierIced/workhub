import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROMPT_NOT_RECEIVED } from '@workhub/core'

/** The renderer's side of a prompt the agent never took: an error line in the chat and the text back in the composer. */
describe('a prompt the agent did not receive', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('says so in the chat and hands the text back, not as an interruption', async () => {
    let started: ((id: string, token: number, seq?: number) => void) | undefined
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      hub: {
        sessions: {
          onPromptStarted: (cb: typeof started) => (started = cb),
          onPromptSettled: () => undefined,
          onChanged: () => undefined,
          onRemoved: () => undefined,
          withdrawPrompt: async () => false,
          cancel: async () => undefined,
          prompt: async (id: string, _text: string, _images: unknown, token: number) => {
            started?.(id, token)
            throw new Error(`${PROMPT_NOT_RECEIVED}: Claude Code did not take this message`)
          }
        }
      }
    })
    const store = await import('../src/renderer/store')
    const queue = await import('../src/renderer/promptQueue')
    store.onChanged({ id: 's1', state: 'ready' } as Parameters<typeof store.onChanged>[0])
    const recovered: unknown[] = []
    queue.onRecoveredPrompts((id, prompts, reason) => recovered.push({ id, prompts, reason }))

    expect(queue.submitPrompt('s1', 'ready', true, 'hello acme')).toBe('sent')
    await vi.waitFor(() => expect(recovered).toHaveLength(1))

    expect(recovered[0]).toEqual({ id: 's1', prompts: [{ text: 'hello acme', images: [] }], reason: 'notReceived' })
    const items = store.getSessions()['s1']?.items ?? []
    expect(items.map((i) => [i.kind, 'text' in i ? i.text : undefined])).toEqual([
      ['user', 'hello acme'],
      ['error', PROMPT_NOT_RECEIVED]
    ])
    // Nothing waits any more: the next message goes out at once.
    expect(queue.submitPrompt('s1', 'ready', true, 'again')).toBe('sent')
  })
})
