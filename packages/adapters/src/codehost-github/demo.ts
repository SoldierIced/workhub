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

const OWNER = 'acme-demo'
const urlOf = (p: DemoPr) => `https://github.com/${OWNER}/${p.repo}/pull/${p.number}`

function iso(now: number, hoursAgo: number): string {
  return new Date(now - hoursAgo * 3_600_000).toISOString()
}

function searchNode(p: DemoPr, now: number) {
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
    commits: { nodes: [{ commit: { oid: `${p.number}`.padStart(7, '0') + 'a1b2c3d4e5f60718293a4b5c6d7e8f90', statusCheckRollup: p.ci ? { state: p.ci } : null } }] }
  }
}

function viewJson(p: DemoPr, now: number) {
  const ci = p.ci
  return {
    number: p.number,
    title: p.title,
    url: urlOf(p),
    body: `Adds the change described in the title.\n\n- Keeps the public API stable\n- Covers the new paths with tests\n\nRefs ${/DEMO-\d+/.exec(p.title)?.[0] ?? 'no ticket'}.`,
    author: { login: p.author, is_bot: false },
    state: 'OPEN',
    isDraft: p.draft ?? false,
    baseRefName: p.base,
    headRefName: p.head,
    headRefOid: `${p.number}`.padStart(7, '0') + 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    createdAt: iso(now, p.hoursAgo + 26),
    updatedAt: iso(now, p.hoursAgo),
    mergedAt: null,
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
export function createDemoRunner(now: number = Date.now()): DemoRunner {
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
        const wanted = q.includes('review-requested:@me') ? (p: DemoPr) => p.review : (p: DemoPr) => p.mine
        return ok(JSON.stringify({ data: { search: { nodes: DEMO_PRS.filter(wanted).map((p) => searchNode(p, now)) } } }))
      }
      if (a === 'api' && args.some((x) => /\/pulls\/\d+\/comments$/.test(x))) {
        // The inline comments exist on the first demo PR only.
        return ok(args.some((x) => x.endsWith(`/pulls/${DEMO_PRS[0]!.number}/comments`)) ? JSON.stringify(inlineComments(now)) : '[]')
      }
      if (a === 'pr' && b === 'view') {
        const p = DEMO_PRS.find((x) => urlOf(x) === args[2])
        return p ? ok(JSON.stringify(viewJson(p, now))) : fail('GraphQL: Could not resolve to a PullRequest (demo)')
      }
      if (a === 'pr' && b === 'diff') return ok(DEMO_DIFF)
      if ((a === 'pr' && (b === 'review' || b === 'comment')) || (a === 'api' && args.some((x) => x.endsWith('/replies')))) return ok('')
      return fail(`unexpected demo call: gh ${args.join(' ')}`)
    },
    { calls }
  )
  return runner
}
