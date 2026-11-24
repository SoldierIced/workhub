import type { MergedCoverage, MergedPullRequest, MergedSearch, MergedStore, StoredMergedPullRequest } from '@workhub/core'

/** An in-memory `MergedStore` that follows the port's documented semantics (the SQLite one does the same). */
export class FakeMergedStore implements MergedStore {
  /** Rows per profile and URL. */
  readonly rows = new Map<string, MergedPullRequest>()
  /** The URLs each search found, by `profile|key`. */
  readonly found = new Map<string, Set<string>>()
  readonly ranges = new Map<string, MergedCoverage[]>()
  calls = 0

  private static key = (s: MergedSearch) => `${s.profileId}\n${s.key}`

  async save(search: MergedSearch, items: readonly MergedPullRequest[]): Promise<void> {
    this.calls++
    const found = this.found.get(FakeMergedStore.key(search)) ?? new Set<string>()
    for (const pr of items) {
      this.rows.set(`${search.profileId}\n${pr.url}`, pr)
      found.add(pr.url)
    }
    this.found.set(FakeMergedStore.key(search), found)
  }

  /** How many times `read` ran. */
  reads = 0
  async read(searches: readonly MergedSearch[], since: number, until: number): Promise<StoredMergedPullRequest[]> {
    this.calls++
    this.reads++
    const out = new Map<string, StoredMergedPullRequest>()
    for (const s of searches) {
      for (const url of this.found.get(FakeMergedStore.key(s)) ?? []) {
        const pr = this.rows.get(`${s.profileId}\n${url}`)
        if (pr && pr.mergedAt >= since && pr.mergedAt < until) out.set(`${s.profileId}\n${url}`, { profileId: s.profileId, pr })
      }
    }
    return [...out.values()].sort((a, b) => b.pr.mergedAt - a.pr.mergedAt || b.pr.number - a.pr.number)
  }

  /** How many `read` would return; counted in `counts`, not in `calls`. */
  counts = 0
  async count(searches: readonly MergedSearch[], since: number, until: number): Promise<number> {
    this.counts++
    const [calls, reads] = [this.calls, this.reads]
    const n = (await this.read(searches, since, until)).length
    this.calls = calls
    this.reads = reads
    return n
  }

  async covered(search: MergedSearch): Promise<MergedCoverage[]> {
    this.calls++
    return (this.ranges.get(FakeMergedStore.key(search)) ?? []).map((r) => ({ ...r }))
  }

  async cover(search: MergedSearch, since: number, until: number, at: number): Promise<void> {
    this.calls++
    if (since >= until) return
    const key = FakeMergedStore.key(search)
    const touching = (this.ranges.get(key) ?? []).filter((r) => r.since <= until && r.until >= since)
    const rest = (this.ranges.get(key) ?? []).filter((r) => !touching.includes(r))
    const all = [...touching, { since, until, at }]
    // The joined range's `at` is the one of the range with the newest end (ties: the larger `at`).
    const newest = all.reduce((a, b) => (b.until > a.until || (b.until === a.until && b.at > a.at) ? b : a))
    rest.push({ since: Math.min(...all.map((r) => r.since)), until: Math.max(...all.map((r) => r.until)), at: newest.at })
    this.ranges.set(key, rest.sort((a, b) => a.since - b.since))
  }
}
