import type { EffectiveAgent, GroupMember } from '@workhub/core'
import { describe, expect, it } from 'vitest'
import { ReopenAgentMissing, reopenInput } from '../src/renderer/lib/reopen'

const agent = (key: string, adapter: 'native' | 'terminal'): EffectiveAgent => ({ key, agent: { id: key.split(':')[0], adapter, capabilities: {} } }) as unknown as EffectiveAgent
const member = (over: Partial<GroupMember> = {}): GroupMember => ({ key: 'conv-1', agentKey: 'claude:acct-b', cwd: '/w/acme/api', profileId: 'work', agentName: 'Claude (B)', ...over }) as GroupMember

describe('reopenInput', () => {
  it('resumes a session moved to an account only its own profile offers, while another profile is active', async () => {
    const asked: (string | null)[] = []
    const agentsOf = async (profileId: string | null) => {
      asked.push(profileId)
      return profileId === 'work' ? [agent('claude:acct-b', 'native')] : [agent('claude:acct-a', 'native')]
    }
    const input = await reopenInput(member(), 'home', agentsOf)
    expect(asked).toEqual(['work'])
    expect(input).toEqual({ profileId: 'work', agentKey: 'claude:acct-b', cwd: '/w/acme/api', resumeAgentSessionId: 'conv-1' })
  })

  it('uses the active profile for a member stored before members had one', async () => {
    const input = await reopenInput(member({ profileId: undefined }), 'home', async (p) => (p === 'home' ? [agent('claude:acct-b', 'native')] : []))
    expect(input.profileId).toBe('home')
    expect(input.resumeAgentSessionId).toBe('conv-1')
  })

  it('reopens an agent without session ids under its old identity', async () => {
    const input = await reopenInput(member({ agentKey: 'shell' }), 'work', async () => [agent('shell', 'terminal')])
    expect(input).toMatchObject({ identity: 'conv-1' })
    expect(input).not.toHaveProperty('resumeAgentSessionId')
  })

  it('resumes a session on an account its profile never offered (resumed from History) when Workhub knows the agent', async () => {
    const agentsOf = async (profileId: string | null) => (profileId === null ? [agent('claude', 'native')] : [agent('claude:acct-a', 'native')])
    const input = await reopenInput(member(), 'home', agentsOf)
    expect(input).toEqual({ profileId: 'work', agentKey: 'claude:acct-b', cwd: '/w/acme/api', resumeAgentSessionId: 'conv-1' })
  })

  it('refuses instead of starting an unrelated chat when Workhub no longer has the agent', async () => {
    await expect(reopenInput(member(), 'home', async () => [])).rejects.toEqual(new ReopenAgentMissing('Claude (B)'))
  })
})
