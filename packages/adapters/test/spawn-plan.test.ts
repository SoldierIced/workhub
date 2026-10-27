import { describe, expect, it } from 'vitest'
import { needsCmdShell, planSpawn, quoteCmdArgument } from '../src/agent-acp/spawn-plan'

describe('planSpawn', () => {
  it('spawns the command untouched on POSIX', () => {
    expect(planSpawn('npx', ['-y', 'pkg'], 'linux')).toEqual({ command: 'npx', args: ['-y', 'pkg'], windowsVerbatimArguments: false })
  })

  it('spawns a Windows .exe directly, without a shell', () => {
    expect(planSpawn('C:\\bin\\agent.exe', ['a b'], 'win32')).toEqual({ command: 'C:\\bin\\agent.exe', args: ['a b'], windowsVerbatimArguments: false })
  })

  it('runs .cmd and .bat through cmd.exe with a quoted command line', () => {
    const plan = planSpawn('C:\\npm\\npx.CMD', ['-y', 'a&b'], 'win32')
    expect(plan.command.toLowerCase()).toMatch(/cmd\.exe$|comspec/i)
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(plan.windowsVerbatimArguments).toBe(true)
    expect(plan.args[3]).toMatch(/^".*"$/)
    expect(plan.args[3]).not.toMatch(/[^^]&/)
  })
})

describe('quoteCmdArgument', () => {
  it('neutralizes every cmd metacharacter', () => {
    const q = quoteCmdArgument('x" & calc | %PATH% ^ > f')
    expect(q).not.toMatch(/(^|[^^])[&|<>%]/)
    expect(q).not.toMatch(/(^|[^^])"/)
  })

  it('escapes embedded quotes and trailing backslashes for the receiving program', () => {
    expect(quoteCmdArgument('a\\')).toBe('^^^"a\\\\^^^"')
    expect(quoteCmdArgument('say "hi"')).toContain('\\^^^"hi\\^^^"')
  })
})

describe('needsCmdShell', () => {
  it('matches .cmd and .bat only, case-insensitively', () => {
    expect(['a.cmd', 'a.BAT', 'a.exe', 'a', 'a.cmd.exe'].map(needsCmdShell)).toEqual([true, true, false, false, false])
  })
})
