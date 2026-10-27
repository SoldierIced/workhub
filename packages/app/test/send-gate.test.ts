import { describe, expect, it } from 'vitest'
import { SendGate } from '../src/main/send-gate'

const flush = () => new Promise((r) => setTimeout(r, 0))

/** A gate whose prompts record when they start and end when the test says so. */
function harness() {
  const gate = new SendGate()
  const started: string[] = []
  const ends: (() => void)[] = []
  const prompt = (text: string) => () => {
    started.push(text)
    return new Promise<string>((resolve) => ends.push(() => resolve(text)))
  }
  const endTurn = async () => {
    ends.shift()?.()
    await flush()
  }
  return { gate, started, prompt, endTurn }
}

describe('SendGate', () => {
  it('runs one prompt per session at a time, in the order they came', async () => {
    const { gate, started, prompt, endTurn } = harness()
    const a = gate.run('s', prompt('a'))
    const b = gate.run('s', prompt('b'))
    const c = gate.run('s', prompt('c'))
    expect(started).toEqual(['a'])
    await endTurn()
    expect(started).toEqual(['a', 'b'])
    await endTurn()
    await endTurn()
    await expect(Promise.all([a, b, c])).resolves.toEqual(['a', 'b', 'c'])
    expect(gate.busy('s')).toBe(false)
  })

  it('keeps sessions apart', () => {
    const { gate, started, prompt } = harness()
    void gate.run('s1', prompt('one'))
    void gate.run('s2', prompt('two'))
    expect(started).toEqual(['one', 'two'])
  })

  it('refuses a try while a prompt runs or waits, and takes it once the session is free', async () => {
    const { gate, started, prompt, endTurn } = harness()
    void gate.run('s', prompt('user'))
    expect(gate.tryRun('s', prompt('review'))).toBeNull()
    void gate.run('s', prompt('queued'))
    await endTurn()
    // The queued one runs now; a try still waits its turn rather than jumping the line.
    expect(gate.tryRun('s', prompt('review'))).toBeNull()
    await endTurn()
    expect(gate.tryRun('s', prompt('review'))).not.toBeNull()
    expect(started).toEqual(['user', 'queued', 'review'])
  })

  it('frees the session when a prompt fails, and drops waiting prompts on withdraw', async () => {
    const { gate, started, prompt, endTurn } = harness()
    await expect(
      gate.run('s', () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(gate.busy('s')).toBe(false)
    void gate.run('s', prompt('running'))
    const waiting = gate.run('s', prompt('waiting'))
    expect(gate.withdraw('s')).toBe(1)
    await expect(waiting).rejects.toThrow('workhub:prompt-withdrawn')
    await endTurn()
    expect(started).toEqual(['running'])
    expect(gate.busy('s')).toBe(false)
  })
})
