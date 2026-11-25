import type { CliResult, CliRunner } from '../shared/cli'

/**
 * Synthetic `gh` answers for screenshots, demos and tests. Everything here is made up: no real
 * repository, person or company. `createDemoRunner` plays the part of the `gh` CLI, so the real
 * GitHub adapter (command building, JSON parsing, mapping) is what runs in the demo.
 */

export const DEMO_LOGIN = 'demo-dev'

interface DemoPr {
  number: number
  repo: string
  title: string
  author: string
  head: string
  base: string
  hoursAgo: number
  draft?: boolean
  decision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  ci?: 'SUCCESS' | 'FAILURE' | 'PENDING' | null
  mergeable?: 'MERGEABLE' | 'CONFLICTING'
  additions: number
  deletions: number
  files: number
  mine: boolean
  review: boolean
}

export const DEMO_PRS: readonly DemoPr[] = [
  { number: 482, repo: 'storefront', title: 'DEMO-212 Add gift card redemption at checkout', author: DEMO_LOGIN, head: 'feat/demo-212-gift-cards', base: 'main', hoursAgo: 3, decision: 'APPROVED', ci: 'SUCCESS', mergeable: 'MERGEABLE', additions: 214, deletions: 31, files: 9, mine: true, review: false },
  { number: 479, repo: 'storefront', title: 'DEMO-198 Cache the catalog query for anonymous users', author: DEMO_LOGIN, head: 'perf/demo-198-catalog-cache', base: 'main', hoursAgo: 20, decision: 'CHANGES_REQUESTED', ci: 'SUCCESS', mergeable: 'MERGEABLE', additions: 96, deletions: 12, files: 4, mine: true, review: false },
  { number: 133, repo: 'billing-api', title: 'DEMO-230 Retry failed webhooks with backoff', author: DEMO_LOGIN, head: 'feat/demo-230-webhook-retry', base: 'main', hoursAgo: 8, decision: 'REVIEW_REQUIRED', ci: 'FAILURE', mergeable: 'MERGEABLE', additions: 158, deletions: 40, files: 6, mine: true, review: false },
  { number: 131, repo: 'billing-api', title: 'DEMO-221 Rename the invoice status enum', author: DEMO_LOGIN, head: 'refactor/demo-221-invoice-status', base: 'main', hoursAgo: 30, decision: 'REVIEW_REQUIRED', ci: 'SUCCESS', mergeable: 'CONFLICTING', additions: 61, deletions: 58, files: 12, mine: true, review: false },
  { number: 57, repo: 'design-system', title: 'Draft: new Tooltip placement options', author: DEMO_LOGIN, head: 'feat/tooltip-placement', base: 'main', hoursAgo: 5, draft: true, decision: null, ci: 'PENDING', mergeable: 'MERGEABLE', additions: 73, deletions: 4, files: 3, mine: true, review: false },
  { number: 49, repo: 'design-system', title: 'Bump the build tooling to the latest major', author: DEMO_LOGIN, head: 'chore/bump-tooling', base: 'main', hoursAgo: 24 * 41, decision: 'REVIEW_REQUIRED', ci: 'SUCCESS', mergeable: 'MERGEABLE', additions: 18, deletions: 18, files: 2, mine: true, review: false },
  { number: 486, repo: 'storefront', title: 'DEMO-240 Show delivery estimate on the product page', author: 'mira-kline', head: 'feat/demo-240-delivery-estimate', base: 'main', hoursAgo: 2, decision: 'REVIEW_REQUIRED', ci: 'SUCCESS', mergeable: 'MERGEABLE', additions: 132, deletions: 9, files: 5, mine: false, review: true },
  { number: 484, repo: 'storefront', title: 'Fix the cart total rounding for multi-currency orders', author: 'tomas-ibarra', head: 'fix/cart-rounding', base: 'main', hoursAgo: 9, decision: 'REVIEW_REQUIRED', ci: 'PENDING', mergeable: 'MERGEABLE', additions: 44, deletions: 20, files: 3, mine: false, review: true },
  { number: 135, repo: 'billing-api', title: 'DEMO-244 Add idempotency keys to the refund endpoint', author: 'priya-nair', head: 'feat/demo-244-idempotent-refunds', base: 'main', hoursAgo: 14, decision: 'REVIEW_REQUIRED', ci: 'FAILURE', mergeable: 'MERGEABLE', additions: 187, deletions: 22, files: 8, mine: false, review: true },
  { number: 60, repo: 'design-system', title: 'Document the focus ring tokens', author: 'li-wen', head: 'docs/focus-ring', base: 'main', hoursAgo: 50, decision: 'REVIEW_REQUIRED', ci: 'SUCCESS', mergeable: 'MERGEABLE', additions: 35, deletions: 2, files: 2, mine: false, review: true }
]

/** A review request that only exists from the second demo step on. */
const LATE_REVIEW: DemoPr = { number: 490, repo: 'billing-api', title: 'DEMO-251 Add the currency to the invoice export', author: 'sam-okafor', head: 'feat/demo-251-invoice-currency', base: 'main', hoursAgo: 0, decision: 'REVIEW_REQUIRED', ci: 'PENDING', mergeable: 'MERGEABLE', additions: 52, deletions: 6, files: 3, mine: false, review: true }

/**
 * The demo moves on when the app asks (`step()` rises): each step changes a few pull requests the
 * way a real day would, so the pull request events can be seen without a real host.
 *  1: a new commit and a failing CI on #482; #479 gets approved.
 *  2: #133 is merged (it leaves the open list); #490 asks for a review.
 *  3: two new comments on #482.
 */
function atStep(p: DemoPr, step: number): DemoPr | null {
  let out = p
  if (p.number === 482 && step >= 1) out = { ...out, ci: 'FAILURE' }
  if (p.number === 479 && step >= 1) out = { ...out, decision: 'APPROVED' }
  if (p.number === 133 && step >= 2) return null
  return out
}

const commentsAt = (p: DemoPr, step: number) => 2 + (p.number === 482 && step >= 3 ? 2 : 0)
const headOf = (p: DemoPr, step: number) => `${p.number}`.padStart(7, '0') + (p.number === 482 && step >= 1 ? 'c9d8e7f6a5b4031221304f5e6d7c8b9a' : 'a1b2c3d4e5f60718293a4b5c6d7e8f90')

const OWNER = 'acme-demo'
const urlOf = (p: DemoPr) => `https://github.com/${OWNER}/${p.repo}/pull/${p.number}`

function iso(now: number, hoursAgo: number): string {
  return new Date(now - hoursAgo * 3_600_000).toISOString()
}

function searchNode(p: DemoPr, now: number, step = 0) {
  return {
    number: p.number,
    title: p.title,
    url: urlOf(p),
    state: 'OPEN',
    isDraft: p.draft ?? false,
    updatedAt: iso(now, p.hoursAgo),
    headRefName: p.head,
    baseRefName: p.base,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.files,
    reviewDecision: p.decision ?? null,
    mergeable: p.mergeable ?? 'MERGEABLE',
    author: { login: p.author },
    repository: { name: p.repo, owner: { login: OWNER } },
    comments: { totalCount: commentsAt(p, step) },
    reviewThreads: { totalCount: 0 },
    commits: { nodes: [{ commit: { oid: headOf(p, step), statusCheckRollup: p.ci ? { state: p.ci } : null } }] }
  }
}

function viewJson(p: DemoPr, now: number, step = 0, state: 'OPEN' | 'MERGED' = 'OPEN', merged?: DemoMerged) {
  const ci = p.ci
  return {
    number: p.number,
    title: p.title,
    url: urlOf(p),
    body: `Adds the change described in the title.\n\n- Keeps the public API stable\n- Covers the new paths with tests\n\nRefs ${/DEMO-\d+/.exec(p.title)?.[0] ?? 'no ticket'}.`,
    author: { login: p.author, is_bot: false },
    state,
    isDraft: p.draft ?? false,
    baseRefName: p.base,
    headRefName: p.head,
    headRefOid: headOf(p, step),
    createdAt: iso(now, merged ? merged.createdHoursAgo : p.hoursAgo + 26),
    updatedAt: iso(now, p.hoursAgo),
    mergedAt: state === 'MERGED' ? iso(now, merged?.hoursAgo ?? 0) : null,
    mergeable: p.mergeable ?? 'MERGEABLE',
    reviewDecision: p.decision ?? '',
    labels: [{ name: 'enhancement' }, ...(p.draft ? [{ name: 'wip' }] : [])],
    reviewRequests: p.review ? [{ __typename: 'User', login: DEMO_LOGIN }] : [{ __typename: 'User', login: 'mira-kline' }],
    reviews: [
      ...(p.decision === 'APPROVED' ? [{ id: 'R_1', author: { login: 'mira-kline' }, body: 'Looks good to me. Nice tests.', state: 'APPROVED', submittedAt: iso(now, p.hoursAgo - 1) }] : []),
      ...(p.decision === 'CHANGES_REQUESTED'
        ? [{ id: 'R_2', author: { login: 'tomas-ibarra' }, body: 'The cache key must include the locale, otherwise users see the wrong language.', state: 'CHANGES_REQUESTED', submittedAt: iso(now, p.hoursAgo - 2) }]
        : [])
    ],
    comments: [
      { id: 'IC_1', author: { login: 'release-bot', is_bot: true }, body: 'Preview deployed to the staging environment.', createdAt: iso(now, p.hoursAgo + 20) },
      { id: 'IC_2', author: { login: 'priya-nair' }, body: 'Should this also cover the guest checkout?', createdAt: iso(now, p.hoursAgo + 5) }
    ],
    commits: [
      { oid: 'c0ffee1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', messageHeadline: 'Add the first version', authors: [{ login: p.author }], committedDate: iso(now, p.hoursAgo + 25) },
      { oid: 'c0ffee2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', messageHeadline: 'Address review feedback', authors: [{ login: p.author }], committedDate: iso(now, p.hoursAgo + 2) }
    ],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: `${urlOf(p)}/checks` },
      { __typename: 'CheckRun', name: 'unit tests', status: ci === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED', conclusion: ci === 'FAILURE' ? 'FAILURE' : ci === 'PENDING' ? '' : 'SUCCESS', detailsUrl: `${urlOf(p)}/checks` },
      { __typename: 'StatusContext', context: 'lint', state: 'SUCCESS', targetUrl: 'https://ci.example.test/lint/1' }
    ],
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.files
  }
}

/** A pull request merged some time ago: `hoursAgo` is when it was merged. */
interface DemoMerged extends DemoPr {
  createdHoursAgo: number
}

const MERGED_REPOS = ['storefront', 'billing-api', 'design-system', 'notifications']
const MERGED_PEOPLE = ['mira-kline', 'tomas-ibarra', 'priya-nair', 'li-wen', 'sam-okafor', DEMO_LOGIN, 'dependabot']
const MERGED_TITLES = [
  'Show the delivery estimate on the product page',
  'Fix the cart total rounding',
  'Add idempotency keys to refunds',
  'Document the focus ring tokens',
  'Retry failed webhooks with backoff',
  'Bump the build tooling',
  'Guest checkout: keep the address between steps',
  'Cache the catalog query for anonymous users'
]

/**
 * About 120 days of merged pull requests (newest first), from a fixed seed so every run is the same:
 * `develop` and `main` in most repositories, `master` in one, two release branches, a hotfix and a bot author.
 */
export function demoMergedPrs(): DemoMerged[] {
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const out: DemoMerged[] = []
  let n = 900
  for (let day = 0; day < 120; day++) {
    const count = Math.floor(rnd() * 3.6)
    for (let i = 0; i < count; i++) {
      const repo = MERGED_REPOS[Math.floor(rnd() * MERGED_REPOS.length)]!
      const r = rnd()
      let base = r < 0.45 ? 'develop' : r < 0.75 ? 'main' : r < 0.9 ? (day < 40 ? 'release/2.5' : 'release/2.4') : 'hotfix/guest-address'
      if (repo === 'design-system') base = base === 'main' ? 'master' : base
      else if (base === 'master') base = 'main'
      const author = MERGED_PEOPLE[Math.floor(rnd() * MERGED_PEOPLE.length)]!
      const additions = Math.round(15 + rnd() ** 2 * 900)
      const hoursAgo = day * 24 + 1 + Math.floor(rnd() * 20)
      const number = n++
      out.push({
        number, repo, title: MERGED_TITLES[Math.floor(rnd() * MERGED_TITLES.length)]!, author, head: `feat/change-${number}`, base,
        hoursAgo, createdHoursAgo: hoursAgo + Math.round(5 + rnd() ** 2 * 190), decision: 'APPROVED', ci: 'SUCCESS', mergeable: 'MERGEABLE',
        additions, deletions: Math.round(additions * (0.1 + rnd() * 0.5)), files: 2 + Math.floor(rnd() * 22), mine: false, review: false
      })
    }
  }
  return out
}

const mergedNode = (p: DemoMerged, now: number) => ({
  number: p.number,
  title: p.title,
  url: urlOf(p),
  mergedAt: iso(now, p.hoursAgo),
  createdAt: iso(now, p.createdHoursAgo),
  headRefName: p.head,
  baseRefName: p.base,
  additions: p.additions,
  deletions: p.deletions,
  changedFiles: p.files,
  author: { login: p.author },
  repository: { name: p.repo, owner: { login: OWNER } }
})

/** Answers a merged search the way GitHub does: the `merged:` window, `author:@me`, 100 per page by cursor, the total in `issueCount`. */
function mergedSearch(args: string[], now: number): CliResult {
  const q = args.find((x) => x.startsWith('q=')) ?? ''
  const range = /merged:(\S+)\.\.(\S+)/.exec(q)
  const from = range ? Date.parse(range[1]!) : -Infinity
  const to = range ? Date.parse(range[2]!) : Infinity
  const mine = q.includes('author:@me')
  const all = demoMergedPrs().filter((p) => {
    const at = Math.floor((now - p.hoursAgo * 3_600_000) / 1000) * 1000
    return at >= from && at <= to && (!mine || p.author === DEMO_LOGIN)
  })
  const offset = Number(args.find((x) => x.startsWith('after='))?.slice(6) ?? 0)
  const page = all.slice(offset, offset + 100)
  const more = offset + 100 < all.length
  return ok(JSON.stringify({ data: { search: { issueCount: all.length, pageInfo: { hasNextPage: more, endCursor: more ? String(offset + 100) : null }, nodes: page.map((p) => mergedNode(p, now)) } } }))
}

function inlineComments(now: number) {
  return [
    { id: 9001, user: { login: 'mira-kline', type: 'User' }, body: 'Could we name this `redeemGiftCard` to match the other verbs?', path: 'src/checkout/gift-card.ts', line: 5, created_at: iso(now, 6) },
    { id: 9002, in_reply_to_id: 9001, user: { login: DEMO_LOGIN, type: 'User' }, body: 'Good point, renaming it.', path: 'src/checkout/gift-card.ts', line: 5, created_at: iso(now, 5) },
    { id: 9003, user: { login: 'lint-bot[bot]', type: 'Bot' }, body: 'Unused import `legacyTotals`.', path: 'src/checkout/gift-card.ts', line: 1, created_at: iso(now, 7) }
  ]
}

export const DEMO_DIFF = `diff --git a/src/checkout/gift-card.ts b/src/checkout/gift-card.ts
new file mode 100644
index 0000000..4d2f1a9
--- /dev/null
+++ b/src/checkout/gift-card.ts
@@ -0,0 +1,14 @@
+import { legacyTotals } from './totals'
+import type { Cart } from './cart'
+
+/** Applies a gift card to a cart and returns the amount left to pay. */
+export function redeemGiftCard(cart: Cart, balanceCents: number): number {
+  const due = cart.totalCents
+  const applied = Math.min(due, balanceCents)
+  if (applied <= 0) return due
+  cart.discounts.push({ kind: 'gift-card', cents: applied })
+  return due - applied
+}
+
+export const GIFT_CARD_MIN_CENTS = 100
+export const GIFT_CARD_MAX_CENTS = 50_000
diff --git a/src/checkout/totals.ts b/src/checkout/totals.ts
index 81c3b2e..a7d90f4 100644
--- a/src/checkout/totals.ts
+++ b/src/checkout/totals.ts
@@ -10,9 +10,12 @@ export function totalCents(cart: Cart): number {
   const items = cart.items.reduce((sum, i) => sum + i.cents * i.quantity, 0)
-  const discounts = cart.discounts.reduce((sum, d) => sum + d.cents, 0)
-  return items - discounts
+  const discounts = cart.discounts.reduce((sum, d) => sum + d.cents, 0)
+  // Never go below zero when discounts exceed the items.
+  return Math.max(0, items - discounts)
 }

 export function itemCount(cart: Cart): number {
   return cart.items.reduce((sum, i) => sum + i.quantity, 0)
 }
diff --git a/assets/card.png b/assets/card.png
new file mode 100644
index 0000000..9a1b2c3
Binary files /dev/null and b/assets/card.png differ
`

export interface DemoRunner extends CliRunner {
  /** Every call made, as `gh <args>`, writes included. */
  calls: string[][]
}

const ok = (stdout = ''): CliResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string): CliResult => ({ code: 1, stdout: '', stderr })

/** A fake `gh`. Reads answer from the synthetic data above; writes only record the call. */
export function createDemoRunner(now: number = Date.now(), step: () => number = () => 0): DemoRunner {
  const calls: string[][] = []
  const runner: DemoRunner = Object.assign(
    async (command: string, args: string[]): Promise<CliResult> => {
      calls.push([command, ...args])
      if (command !== 'gh') return fail(`${command}: not available in demo mode`)
      const [a, b] = args
      if (a === 'auth' && b === 'token') return ok('gho_demo_token_not_real\n')
      if (a === 'api' && args.includes('user')) return ok(`${DEMO_LOGIN}\n`)
      if (a === 'api' && args.includes('graphql')) {
        const q = args.find((x) => x.startsWith('q=')) ?? ''
        if (q.includes('is:merged')) return mergedSearch(args, now)
        const wanted = q.includes('review-requested:@me') ? (p: DemoPr) => p.review : (p: DemoPr) => p.mine
        const s = step()
        const open = [...DEMO_PRS, ...(s >= 2 ? [LATE_REVIEW] : [])].flatMap((p) => atStep(p, s) ?? [])
        return ok(JSON.stringify({ data: { search: { nodes: open.filter(wanted).map((p) => searchNode(p, now, s)) } } }))
      }
      if (a === 'api' && args.some((x) => /\/pulls\/\d+\/comments$/.test(x))) {
        // The inline comments exist on the first demo PR only.
        return ok(args.some((x) => x.endsWith(`/pulls/${DEMO_PRS[0]!.number}/comments`)) ? JSON.stringify(inlineComments(now)) : '[]')
      }
      if (a === 'pr' && b === 'view') {
        const s = step()
        const p = [...DEMO_PRS, LATE_REVIEW].find((x) => urlOf(x) === args[2])
        const merged = p ? undefined : demoMergedPrs().find((x) => urlOf(x) === args[2])
        if (merged) return ok(JSON.stringify(viewJson(merged, now, s, 'MERGED', merged)))
        if (!p) return fail('GraphQL: Could not resolve to a PullRequest (demo)')
        const staged = atStep(p, s)
        // A PR the demo removed from the open list reads as merged.
        return ok(JSON.stringify(staged ? viewJson(staged, now, s) : viewJson(p, now, s, 'MERGED')))
      }
      if (a === 'pr' && b === 'diff') return ok(DEMO_DIFF)
      if ((a === 'pr' && (b === 'review' || b === 'comment' || b === 'close')) || (a === 'api' && args.some((x) => x.endsWith('/replies')))) return ok('')
      return fail(`unexpected demo call: gh ${args.join(' ')}`)
    },
    { calls }
  )
  return runner
}
