import { describe, expect, it } from 'vitest'
import { killProcessTree, needsCmdShell, planSpawn, quoteCmdArgument } from '../src/agent-acp/spawn-plan'

describe('planSpawn', () => {
  it('spawns the command untouched on POSIX', () => {
    expect(planSpawn('npx', ['-y', 'pkg'], 'linux')).toEqual({ command: 'npx', args: ['-y', 'pkg'], windowsVerbatimArguments: false, detached: true })
  })

  it('spawns a Windows .exe directly, without a shell', () => {
    expect(planSpawn('C:\\bin\\agent.exe', ['a b'], 'win32')).toEqual({ command: 'C:\\bin\\agent.exe', args: ['a b'], windowsVerbatimArguments: false, detached: false })
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

describe('killProcessTree', () => {
  const fakeChild = () => {
    const signals: string[] = []
    return { signals, child: { pid: 4242, kill: (signal?: NodeJS.Signals | number) => (signals.push(String(signal)), true) } }
  }

  it('signals the process group on POSIX', () => {
    const { child, signals } = fakeChild()
    const calls: [number, string][] = []
    killProcessTree(child, 'SIGTERM', { platform: 'darwin', kill: (pid, signal) => void calls.push([pid, signal]) })
    expect(calls).toEqual([[-4242, 'SIGTERM']])
    expect(signals).toEqual([])
  })

  it('falls back to the child alone when the group cannot be signalled', () => {
    const { child, signals } = fakeChild()
    killProcessTree(child, 'SIGKILL', {
      platform: 'linux',
      kill: () => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      }
    })
    expect(signals).toEqual(['SIGKILL'])
  })

  it('ends the tree with taskkill on Windows, and falls back when taskkill cannot start', () => {
    const { child, signals } = fakeChild()
    const runs: [string, string[]][] = []
    let onError: (() => void) | undefined
    const once = ((event: string, cb: () => void) => {
      if (event === 'error') onError = cb
      return undefined as never
    }) as never
    killProcessTree(child, 'SIGTERM', { platform: 'win32', spawn: (command, args) => (runs.push([command, args]), { once }) })
    expect(runs).toEqual([['taskkill', ['/T', '/F', '/PID', '4242']]])
    expect(signals).toEqual([])
    onError?.()
    expect(signals).toEqual(['SIGTERM'])
  })

  it('does nothing for a child that never started', () => {
    const calls: number[] = []
    killProcessTree({ pid: undefined, kill: () => true }, 'SIGTERM', { platform: 'linux', kill: (pid) => void calls.push(pid) })
    expect(calls).toEqual([])
  })
})
