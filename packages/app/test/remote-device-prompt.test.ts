import { describe, expect, it } from 'vitest'
import { isRemoteSender, promptFromDevice } from '../src/main/remote'

describe('promptFromDevice', () => {
  it('shows the prompt in the windows when it goes out, then the end of its turn', async () => {
    const shown: string[] = []
    let start: () => void = () => {}
    let finish: (stopReason: string) => void = () => {}
    const result = promptFromDevice(
      {
        prompt: (_id, _text, _images, options) => {
          start = options.onStart
          return new Promise((resolve) => (finish = resolve))
        },
        showPrompt: (id, text) => shown.push(`prompt ${id} ${text}`),
        showTurnEnd: (id, stopReason) => shown.push(`end ${id} ${stopReason}`)
      },
      's1',
      'hello from the phone'
    )
    // Waiting behind another prompt: nothing shows yet.
    expect(shown).toEqual([])
    start()
    expect(shown).toEqual(['prompt s1 hello from the phone'])
    finish('end_turn')
    await expect(result).resolves.toBe('end_turn')
    expect(shown).toEqual(['prompt s1 hello from the phone', 'end s1 end_turn'])
  })

  it('shows nothing when the prompt never went out', async () => {
    const shown: string[] = []
    await expect(
      promptFromDevice(
        {
          prompt: () => Promise.reject(new Error('withdrawn')),
          showPrompt: () => shown.push('prompt'),
          showTurnEnd: () => shown.push('end')
        },
        's1',
        'hi'
      )
    ).rejects.toThrow('withdrawn')
    expect(shown).toEqual([])
  })
})

describe('isRemoteSender', () => {
  it('tells a device apart from a window', () => {
    expect(isRemoteSender(3)).toBe(false)
    expect(isRemoteSender(1_000_000)).toBe(true)
  })
})
