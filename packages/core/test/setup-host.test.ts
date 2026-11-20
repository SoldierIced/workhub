import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS, hostAgentAvailability, hostToolItems, problemCount, type Probe } from '../src'

const ok = (output: string): Probe => ({ result: 'ok', output })
const notFound: Probe = { result: 'notFound', output: '' }

describe('tools checked inside a WSL host', () => {
  it('waits, without a problem, while the host has not connected', () => {
    const items = hostToolItems('Ubuntu', null)
    expect(items.map((i) => [i.kind, i.status, i.code, i.params['host']])).toEqual([
      ['claudeCode', 'pending', 'hostPending', 'Ubuntu'],
      ['claudeSignIn', 'pending', 'hostPending', 'Ubuntu'],
      ['git', 'pending', 'hostPending', 'Ubuntu']
    ])
    expect(problemCount(items)).toBe(0)
    expect(items.every((i) => i.fix === undefined)).toBe(true)
  })

  it('reads what the host found, and never offers a fix that runs on this computer', () => {
    const [claude, signIn, git] = hostToolItems('Ubuntu', {
      claude: ok('2.1.0 (Claude Code)'),
      auth: ok(JSON.stringify({ loggedIn: true, email: 'dev@example.com' })),
      git: ok('git version 2.43.0')
    })
    expect([claude!.status, claude!.params['version'], claude!.params['host']]).toEqual(['ok', '2.1.0', 'Ubuntu'])
    expect([signIn!.status, signIn!.params['who']]).toEqual(['ok', 'dev@example.com'])
    expect(signIn!.id).toBe('claudeSignIn:wsl:Ubuntu')
    expect([git!.status, git!.params['version']]).toEqual(['ok', '2.43.0'])

    const missing = hostToolItems('Ubuntu', { claude: notFound, auth: ok(JSON.stringify({ loggedIn: false })), git: notFound })
    expect(missing.map((i) => [i.status, i.code, i.fix])).toEqual([
      ['missing', 'claudeMissing', undefined],
      ['missing', 'hostNotSignedIn', undefined],
      ['missing', 'gitMissing', undefined]
    ])
  })
})

describe('agents on a WSL host', () => {
  it('offers Claude Code once the host connects and names the others unavailable there', () => {
    const connected = hostAgentAvailability(BUILTIN_AGENTS, true)
    expect(connected['claude']).toBe(true)
    for (const id of ['claude-acp', 'kiro', 'opencode', 'codex', 'gemini', 'shell']) expect(connected[id]).toBe('unsupported')
    expect(hostAgentAvailability(BUILTIN_AGENTS, false)['claude']).toBe('pending')
  })
})
