import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { emptyConfig, knownAgents, launchEnvironment, type WorkhubConfig } from '@workhub/core'
import { claudeConfigDirOf, claudeLaunchDir } from '../src/main/claude-accounts'

const work = { id: 'work', agentId: 'claude', name: 'Work', configDir: '/tmp/acme-claude-work' }
const main = { id: 'main', agentId: 'claude', name: 'Main', configDir: '/tmp/acme-home/.claude' }
const config: WorkhubConfig = { ...emptyConfig(), accounts: [work, main] }

describe('claudeLaunchDir', () => {
  it('names the folder of an account that has its own', () => {
    expect(claudeLaunchDir(config, work)).toEqual({ kind: 'named', dir: resolve('/tmp/acme-claude-work') })
  })

  it('names nothing for the default account', () => {
    expect(claudeLaunchDir(config, null)).toEqual({ kind: 'default' })
  })

  it('names a folder whenever the account carries one, the default path included, as a session does', () => {
    // `main` is configured with Claude's default folder (`~/.claude`): a session still names it.
    expect(claudeLaunchDir(config, main)).toEqual({ kind: 'named', dir: resolve('/tmp/acme-home/.claude') })
    expect(claudeLaunchDir(config, { ...main, configDir: '/tmp/acme-home/.claude/' })).toEqual({ kind: 'named', dir: resolve('/tmp/acme-home/.claude') })
    // The same environment a session gets: the rule is the one `launchEnvironment` answers.
    const agent = knownAgents(config).find((a) => a.id === 'claude')!
    expect(launchEnvironment(agent, main)['CLAUDE_CONFIG_DIR']).toBe('/tmp/acme-home/.claude')
  })

  it('follows the Claude agent’s own folder, as a session does', () => {
    const withEnv = { ...config, agents: [{ id: 'claude', name: 'Claude', command: 'claude', args: [], env: { CLAUDE_CONFIG_DIR: '/tmp/acme-agent' }, accountConfigEnv: 'CLAUDE_CONFIG_DIR' }] } as unknown as WorkhubConfig
    expect(claudeLaunchDir(withEnv, null)).toEqual({ kind: 'named', dir: resolve('/tmp/acme-agent') })
  })

  it('leaves the folder to find files in untouched: it still resolves the default', () => {
    expect(claudeConfigDirOf(config, null, '/tmp/acme-home', {})).toBe(resolve('/tmp/acme-home/.claude'))
  })
})

describe('claudeLaunchDir without a Claude agent', () => {
  it('says so, apart from the default', async () => {
    vi.resetModules()
    vi.doMock('@workhub/core', async (original) => ({ ...(await original<typeof import('@workhub/core')>()), knownAgents: () => [] }))
    const { claudeLaunchDir: bare } = await import('../src/main/claude-accounts')
    expect(bare(config, null)).toEqual({ kind: 'noClaude' })
    vi.doUnmock('@workhub/core')
  })
})
