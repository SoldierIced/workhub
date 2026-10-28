import { describe, expect, it } from 'vitest'
import { automationOfHistory, groupAutomationHistory, linkAutomationHistory, newAutomation, type HistoryEntry } from '../src'

const HOME = '/home/u'
const reviews = newAutomation('a-rev', { name: 'PR reviews', prompt: '/slack-pr-review max=1', agentKey: 'claude:work', folder: '~/wayni' })
const digest = newAutomation('a-dig', { name: '', prompt: 'Summarize the inbox', agentKey: 'claude', folder: '~' })
const automations = [reviews, digest]

let n = 0
function entry(fields: Partial<HistoryEntry> = {}): HistoryEntry {
  n++
  return { agentId: 'claude', accountId: 'work', agentSessionId: `s${n}`, title: `Session ${n}`, cwd: `${HOME}/wayni`, lastModified: 1_000 + n, ...fields }
}

describe('automation runs in History', () => {
  it('links a session Workhub started for an automation by its identity', () => {
    const e = entry({ firstPrompt: 'something else entirely' })
    expect(automationOfHistory(e, automations, { [e.agentSessionId]: 'a-rev' }, HOME)?.id).toBe('a-rev')
    // A link to a removed automation falls back to the prompt, which matches nothing here.
    expect(automationOfHistory(e, automations, { [e.agentSessionId]: 'gone' }, HOME)).toBeUndefined()
  })

  it('recognizes an older run by its first prompt, with the same agent in the automation folder', () => {
    expect(automationOfHistory(entry({ firstPrompt: '/slack-pr-review  max=1' }), automations, {}, HOME)?.id).toBe('a-rev')
    // Claude's listing keeps only a slash command's name.
    expect(automationOfHistory(entry({ firstPrompt: '/slack-pr-review' }), automations, {}, HOME)?.id).toBe('a-rev')
    expect(automationOfHistory(entry({ firstPrompt: 'Summarize the inbox', cwd: HOME }), automations, {}, HOME)?.id).toBe('a-dig')
    // Not exactly the prompt, another folder or another agent: a normal session.
    expect(automationOfHistory(entry({ firstPrompt: 'Summarize the inbox please', cwd: HOME }), automations, {}, HOME)).toBeUndefined()
    expect(automationOfHistory(entry({ firstPrompt: '/slack-pr-review max=1', cwd: '/elsewhere' }), automations, {}, HOME)).toBeUndefined()
    expect(automationOfHistory(entry({ firstPrompt: '/slack-pr-review max=1', agentId: 'codex' }), automations, {}, HOME)).toBeUndefined()
    expect(automationOfHistory(entry({}), automations, {}, HOME)).toBeUndefined()
  })

  it('groups the runs per automation, mixed with normal sessions, with counts and newest first', () => {
    const linked = entry({ lastModified: 5_000 })
    const old1 = entry({ firstPrompt: '/slack-pr-review', lastModified: 2_000 })
    const old2 = entry({ firstPrompt: '/slack-pr-review max=1', lastModified: 3_000 })
    const dig = entry({ firstPrompt: 'Summarize the inbox', cwd: HOME, lastModified: 9_000 })
    const normal1 = entry({ firstPrompt: 'fix the login bug', lastModified: 8_000 })
    const normal2 = entry({ firstPrompt: 'write tests', lastModified: 1_000 })
    // The same run listed by a second account: kept once, the newest copy.
    const copy = { ...linked, accountId: null, lastModified: 6_000 }
    const all = linkAutomationHistory([normal2, old1, linked, dig, normal1, old2, copy], automations, { [linked.agentSessionId]: 'a-rev' }, HOME)
    const { groups, rest } = groupAutomationHistory(all)
    expect(groups.map((g) => [g.automationId, g.name, g.entries.length, g.lastModified])).toEqual([
      ['a-dig', 'Summarize the inbox', 1, 9_000],
      ['a-rev', 'PR reviews', 3, 6_000]
    ])
    expect(groups[1]!.entries.map((e) => [e.agentSessionId, e.lastModified])).toEqual([
      [linked.agentSessionId, 6_000],
      [old2.agentSessionId, 3_000],
      [old1.agentSessionId, 2_000]
    ])
    expect(rest.map((e) => e.agentSessionId)).toEqual([normal2.agentSessionId, normal1.agentSessionId])
  })

  it('searches inside the runs and by the automation name', () => {
    const a = entry({ firstPrompt: '/slack-pr-review', title: 'Reviewed acme/web#12' })
    const b = entry({ firstPrompt: '/slack-pr-review', title: 'Reviewed acme/api#3' })
    const all = linkAutomationHistory([a, b], automations, {}, HOME)
    expect(groupAutomationHistory(all, 'api').groups[0]!.entries.map((e) => e.agentSessionId)).toEqual([b.agentSessionId])
    expect(groupAutomationHistory(all, 'pr reviews').groups[0]!.entries).toHaveLength(2)
    expect(groupAutomationHistory(all, 'nothing like it').groups).toEqual([])
  })
})
