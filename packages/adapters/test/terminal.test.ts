import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS, type AgentDefinition, type AgentEvent } from '@workhub/core'
import { TerminalRuntime } from '../src/agent-terminal'

const shell = BUILTIN_AGENTS.find((a) => a.id === 'shell')!

function waitFor(events: AgentEvent[], predicate: (e: AgentEvent) => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      if (events.some(predicate)) resolve()
      else if (Date.now() - started > ms) reject(new Error('timed out'))
      else setTimeout(tick, 20)
    }
    tick()
  })
}

// node-pty is N-API, so the same build runs under Node (tests) and Electron (app).
describe.skipIf(process.platform === 'win32')('TerminalRuntime', () => {
  it('runs a command in a PTY and reports output, exit and state', async () => {
    const rt = new TerminalRuntime()
    const events: AgentEvent[] = []
    rt.subscribe((e) => events.push(e))
    const agent: AgentDefinition = { ...shell, id: 'echo', name: 'Echo', command: '/bin/echo', args: ['hello from pty'] }
    const started = await rt.start({ sessionId: 't1', agent, account: null, cwd: process.cwd(), env: {} })
    expect(started.permissionMode?.source).toBe('unknown')
    await waitFor(events, (e) => e.type === 'state' && e.state === 'stopped')
    const output = events.flatMap((e) => (e.type === 'output' ? [e.data] : [])).join('')
    expect(output).toContain('hello from pty')
    expect(events).toContainEqual({ sessionId: 't1', type: 'exit', code: 0 })
  })

  it('types prompts into an interactive program and passes env', async () => {
    const rt = new TerminalRuntime({ defaultShell: '/bin/sh' })
    const events: AgentEvent[] = []
    rt.subscribe((e) => events.push(e))
    await rt.start({ sessionId: 't2', agent: shell, account: null, cwd: process.cwd(), env: { ACME_VALUE: 'acme-42' } })
    await rt.prompt('t2', 'echo "value=$ACME_VALUE"')
    await waitFor(events, (e) => e.type === 'output' && e.data.includes('value=acme-42'))
    rt.resize('t2', 100, 30)
    await rt.stop('t2')
    await waitFor(events, (e) => e.type === 'state' && e.state === 'stopped')
    await expect(rt.prompt('t2', 'x')).rejects.toThrow(/no terminal session/)
  })

  it('reports no structured capabilities', () => {
    expect(Object.values(new TerminalRuntime().capabilities(shell)).every((v) => v === false)).toBe(true)
  })
})
