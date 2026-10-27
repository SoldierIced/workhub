import { describe, expect, it } from 'vitest'
import { asksForAction, ConsoleActivity, isSpinner } from '../src/main/console-activity'

describe('console activity (Claude Code terminal UI)', () => {
  it('tells a spinner title from the idle one', () => {
    expect(isSpinner('⠐ Fixing the build')).toBe(true)
    expect(isSpinner('◑ Working')).toBe(true)
    expect(isSpinner('✳ Claude Code')).toBe(false)
    expect(isSpinner('')).toBe(false)
  })

  it('reads titles set with OSC 0 or 2, ended by BEL or ST, also across chunks', () => {
    const a = new ConsoleActivity()
    expect(a.feed('text \x1b]2;⠐ Work')).toBe(false)
    expect(a.feed('ing\x1b\\ more')).toBe(true)
    expect(a.busy).toBe(true)
    a.feed('\x1b]0;✳ Claude Code\x07')
    expect(a.title).toBe('✳ Claude Code')
    expect(a.busy).toBe(false)
  })

  it('stays busy after a notification that asks for action until work resumes or the user types', () => {
    const a = new ConsoleActivity()
    a.feed('\x1b]0;✳ Claude Code\x07\x1b]777;notify;Claude Code;Claude needs your permission to use Bash\x07')
    expect(a.busy).toBe(true)
    a.feed('\x1b]0;⠐ Running\x07')
    expect(a.asking).toBe(false)
    a.feed('\x1b]0;✳ Claude Code\x07\x1b]9;Claude has a question for you\x07')
    expect(a.busy).toBe(true)
    a.typed()
    expect(a.busy).toBe(false)
    a.feed('\x1b]9;Claude is done\x07')
    expect(a.busy).toBe(false)
    // Claude's idle reminder is not a question.
    expect(asksForAction('Claude is waiting for your input')).toBe(false)
  })
})
