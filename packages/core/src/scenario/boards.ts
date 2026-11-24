/**
 * The demo's sample board: a made-up release ("Release 4.2") across three services, caught
 * mid-flight, so every kind of block and state is on show. Synthetic names only.
 */
import type { Board } from '../boards/types'

const MIN = 60_000

export function productBoard(now: number): Board {
  const ago = (minutes: number) => now - minutes * MIN
  return {
    format: 'workhub.board',
    version: 1,
    id: 'release-4-2',
    title: 'Release 4.2',
    subtitle: 'Sample board: three services shipped by a lead agent, three builders and a reviewer. It does not move.',
    status: 'live',
    heartbeatSeconds: 3600,
    blocks: [
      {
        type: 'steps',
        title: 'Stages',
        steps: [
          { label: 'Plan', state: 'done', at: ago(95) },
          { label: 'Build', state: 'done', at: ago(40) },
          { label: 'Review', state: 'current', at: ago(12) },
          { label: 'Load test', state: 'skipped' },
          { label: 'Deploy', state: 'upcoming' },
          { label: 'Announce', state: 'upcoming' }
        ],
        note: 'Load test is skipped: the change only touches copy and one query.'
      },
      {
        type: 'graph',
        title: 'Who asks whom',
        nodes: [
          { id: 'lead', label: 'Lead agent', detail: 'orchestrator', model: 'opus', tokens: 184_000, startedAt: ago(95), hint: 'Splits the release into one task per service and collects the results.', state: 'active', col: 0, row: 1 },
          { id: 'api', label: 'Builder: api', detail: 'acme-api', model: 'sonnet', tokens: 96_500, startedAt: ago(70), endedAt: ago(22), state: 'done', col: 1, row: 0 },
          { id: 'web', label: 'Builder: web', detail: 'acme-web', model: 'sonnet', tokens: 41_200, startedAt: ago(35), state: 'active', col: 1, row: 1 },
          { id: 'jobs', label: 'Builder: jobs', detail: 'acme-jobs', model: 'sonnet', tokens: 23_800, startedAt: ago(50), state: 'blocked', hint: 'Waiting for a schema decision from the lead.', col: 1, row: 2 },
          { id: 'reviewer', label: 'Reviewer', detail: 'read-only', model: 'opus', startedAt: ago(12), state: 'active', col: 2, row: 1 },
          { id: 'ops', label: 'Deploy bot', detail: 'not started', state: 'placeholder', col: 3, row: 1 }
        ],
        edges: [
          { from: 'lead', to: 'api', label: 'task', state: 'idle' },
          { from: 'lead', to: 'web', label: 'task', state: 'flowing' },
          { from: 'lead', to: 'jobs', label: 'task', state: 'idle' },
          { from: 'api', to: 'reviewer', label: 'diff', state: 'idle' },
          { from: 'web', to: 'reviewer', label: 'diff', state: 'flowing' },
          { from: 'jobs', to: 'lead', label: 'question', state: 'returning' },
          { from: 'reviewer', to: 'ops', label: 'approve' }
        ]
      },
      {
        type: 'table',
        title: 'Decisions',
        columns: [{ label: '#', width: 0.5 }, { label: 'Decision', width: 3 }, { label: 'Who', width: 1 }],
        rows: [
          { cells: ['1', 'Ship the three services together', 'Lead agent'], tone: 'good', agent: 'lead' },
          { cells: ['2', 'Run the load test before deploy', 'Lead agent'], struck: true, agent: 'lead' },
          { cells: ['3', 'Skip the load test: no traffic-facing change', 'Lead agent'], tone: 'good', agent: 'lead' },
          { cells: ['4', 'Backfill the new column in 4.3', 'Pending'], tone: 'warn', agent: 'jobs' }
        ],
        note: 'Struck rows were replaced by a later decision.'
      },
      {
        type: 'list',
        title: 'Agents',
        items: [
          { id: 'lead', label: 'Lead agent', detail: 'orchestrator', state: { label: 'coordinating', tone: 'info', busy: true }, text: 'Waiting on the schema question from jobs.\nReview of api is done.', at: ago(1) },
          { id: 'api', label: 'Builder: api', detail: 'acme-api', state: { label: 'done', tone: 'good' }, text: 'Pagination fix merged into the release branch.', at: ago(22) },
          { id: 'web', label: 'Builder: web', detail: 'acme-web', state: { label: 'working', tone: 'info', busy: true }, text: 'Updating the settings page copy.', at: ago(2) },
          { id: 'jobs', label: 'Builder: jobs', detail: 'acme-jobs', state: { label: 'blocked', tone: 'warn' }, text: 'Needs a decision: backfill the new column now or in a later release.', at: ago(9) },
          { id: 'reviewer', label: 'Reviewer', detail: 'read-only', state: { label: 'reviewing', tone: 'muted' }, at: ago(4) }
        ],
        empty: 'No agents yet.'
      },
      {
        type: 'log',
        title: 'Log',
        detailLabel: 'Show tool calls',
        entries: [
          { at: ago(90), text: 'Plan agreed: three services, one release branch.', tone: 'info' },
          { at: ago(60), text: 'api: pagination fix started.', detail: true },
          { at: ago(40), text: 'api: tests green.', tone: 'good' },
          { at: ago(30), text: 'web: settings copy updated in two files.', detail: true },
          { at: ago(22), text: 'api: merged into the release branch.', tone: 'good' },
          { at: ago(12), text: 'Review started on api and web.', tone: 'neutral' },
          { at: ago(9), text: 'jobs: blocked, needs the backfill decision.', tone: 'warn' },
          { at: ago(5), text: 'reviewer: one comment on web, a missing translation.', tone: 'bad' },
          { at: ago(3), text: 'reviewer: read web/settings.tsx', detail: true, tone: 'muted' }
        ]
      },
      { type: 'text', title: 'Note', text: 'This is a sample board that does not move. A real tool sends a new copy of the whole board each time something changes.', tone: 'muted' }
    ]
  }
}
