/**
 * A control endpoint with synthetic data for the agent-tools benchmark (run.mjs): the real
 * routing (control-server.ts) and the real automations/history logic (automation-control.ts), with
 * Plan answered from fixed data. It never touches a Workhub data folder.
 *
 *   npx tsx scripts/bench-agent-tools/server.mts <socket path> <request log path>
 */
import { appendFileSync } from 'node:fs'
import { newAutomation, type AutomationDefinition, type HistoryMessage } from '@workhub/core'
import { createAutomationControl } from '../../packages/app/src/main/automation-control'
import { startControlServer, type ControlReply } from '../../packages/app/src/main/control-server'
import type { HistoryItem } from '../../packages/app/src/shared/api'
import type { AutomationsSnapshot } from '../../packages/app/src/shared/chat-api'

const [socket, logFile] = process.argv.slice(2)
if (!socket || !logFile) throw new Error('usage: server.mts <socket> <log>')

export const BENCH_SESSION = 'bench-session'
const day = (h: number, m = 0) => {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}
const ok = (body: Record<string, unknown>): ControlReply => ({ status: 200, body: { ok: true, ...body } })

let defs: AutomationDefinition[] = [newAutomation('a1', { name: 'PR reviews', prompt: '/review-prs', profileId: 'work', agentKey: 'claude', folder: '~/work/acme-api', triggers: { chatChannelIds: [], prOwner: 'acme', intervalMinutes: 15 } })]
const history: HistoryItem[] = [
  { agentId: 'claude', accountId: null, agentSessionId: 'h-101', title: 'Roll back the checkout deploy', firstPrompt: 'the checkout deploy broke payments, roll it back', cwd: '/w/acme/checkout', gitBranch: 'fix/rollback', lastModified: Date.now() - 86_400_000, agentName: 'Claude Code', resumable: true },
  { agentId: 'claude', accountId: null, agentSessionId: 'h-102', title: 'Add retries to the invoice job', cwd: '/w/acme/billing', lastModified: Date.now() - 2 * 86_400_000, agentName: 'Claude Code', resumable: true },
  { agentId: 'codex', accountId: null, agentSessionId: 'h-103', title: 'Write the onboarding doc', cwd: '/w/acme/docs', lastModified: Date.now() - 3 * 86_400_000, agentName: 'Codex', resumable: false }
]
const messages: HistoryMessage[] = [
  { kind: 'user', text: 'the checkout deploy broke payments, roll it back' },
  { kind: 'tool', id: 't1', title: 'git revert 4f2a1c9' },
  { kind: 'agent', text: 'Reverted commit 4f2a1c9 (new payment client) on fix/rollback, redeployed v2.14.3 and confirmed payments succeed again. Opened PAY-123 to retry the client upgrade with a feature flag.' }
]

const automations = createAutomationControl({
  sessionProfile: (id) => (id === BENCH_SESSION ? 'work' : undefined),
  profiles: async () => ({ ids: ['work'], active: 'work' }),
  snapshot: (): AutomationsSnapshot => ({
    automations: defs.map((definition) => ({ definition, health: 'healthy', startedInWindow: 0, startedToday: 0, active: true })) as unknown as AutomationsSnapshot['automations'],
    runs: []
  }),
  save: async (a) => {
    defs = defs.some((d) => d.id === a.id) ? defs.map((d) => (d.id === a.id ? a : d)) : [...defs, a]
    return { ok: true, value: {} as never }
  },
  agentKeys: async () => ['claude'],
  history: async () => ({ entries: history, errors: [] }),
  messages: async () => messages,
  newId: () => `a${defs.length + 1}`
})

const server = await startControlServer(socket, {
  openReview: () => ({ ok: true }),
  addInboxItems: async (body) => {
    const items = (body as { items?: unknown[] })?.items ?? []
    return { ok: true, added: items.map((_, i) => `i${i + 1}`), duplicates: [] }
  },
  plan: {
    today: async () =>
      ok({
        state: 'ready',
        now: new Date().toISOString(),
        calendars: [{ name: 'Work', ok: true }],
        events: [
          { id: 'e1', title: 'Checkout weekly sync', start: day(10), end: day(10, 30), allDay: false, meetingUrl: 'https://meet.example.com/abc', attendees: [{ name: 'Ana', email: 'ana@example.com' }, { name: 'Leo', email: 'leo@example.com' }], recurring: true },
          { id: 'e2', title: 'Billing roadmap review', start: day(15), end: day(16), allDay: false, attendees: [{ name: 'Mia', email: 'mia@example.com' }], recurring: false }
        ]
      }),
    inbox: async () => ok({ enabled: true, items: [], total: 0 }),
    updateItem: async () => ok({}),
    milestones: async () => ok({ milestones: [] }),
    changeMilestone: async () => ok({ applied: true }),
    people: async () => ok({ people: [] })
  },
  automations: {
    ...automations,
    list: async (p) => automations.list(p),
    create: async (b, p) => {
      appendFileSync(logFile, `${JSON.stringify({ created: (b as { automation?: unknown })?.automation })}\n`)
      return automations.create(b, p)
    }
  },
  log: (m) => console.error(m)
})
if (!server) throw new Error('could not listen')
// Every request, for checking what each run did.
server.prependListener('request', (req) => appendFileSync(logFile, `${JSON.stringify({ method: req.method, url: req.url })}\n`))
console.log('listening')
