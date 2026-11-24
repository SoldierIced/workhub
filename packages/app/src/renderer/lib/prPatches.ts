// What the user just did to a pull request, applied on top of what the host last reported until the host catches up.
import type { PullRequestDetail, PullRequestItem } from '@workhub/core'
import { classifyPullRequest } from '@workhub/core'
import type { CodeHostLists } from '../../shared/codehost-api'

/** How long a local patch outlives the action, unless a refresh shows the PR changed after it. */
export const PATCH_TTL_MS = 2 * 60_000

export interface PrPatch {
  /** When the host confirmed the action (local clock). */
  at: number
  /** A review was sent: the PR leaves "To review". */
  reviewed?: boolean
  /** The PR was merged or closed. */
  state?: 'merged' | 'closed'
}

const patches = new Map<string, PrPatch>()
const listeners = new Set<() => void>()
let version = 0

function bump(): void {
  version++
  for (const l of listeners) l()
}

export const subscribePatches = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const patchesVersion = (): number => version

/** Remembers an action the host confirmed; actions on the same PR add up. */
export function recordPatch(url: string, change: Omit<PrPatch, 'at'>, now = Date.now()): void {
  patches.set(url, { ...patches.get(url), ...change, at: now })
  bump()
}

/** The live patch of a PR (none once it is older than the time to live). */
export function patchFor(url: string, now = Date.now()): PrPatch | undefined {
  const p = patches.get(url)
  return p && now - p.at <= PATCH_TTL_MS ? p : undefined
}

/**
 * A refresh reported the PR (`updatedAt` as the host says): the patch ends when it expired or when the
 * PR changed after the action (the refresh then holds the truth). A refresh that did not change it never undoes a patch.
 */
export function settlePatch(url: string, updatedAt: number | undefined, now = Date.now()): void {
  const p = patches.get(url)
  if (!p) return
  if (now - p.at > PATCH_TTL_MS || (updatedAt !== undefined && updatedAt > p.at)) {
    patches.delete(url)
    bump()
  }
}

/** Forgets every patch (tests). */
export function clearPatches(): void {
  patches.clear()
  bump()
}

export function patchDetail(detail: PullRequestDetail, patch: PrPatch | undefined): PullRequestDetail {
  if (!patch?.state || detail.state === patch.state) return detail
  return { ...detail, state: patch.state, ...(patch.state === 'merged' ? { mergedAt: patch.at } : {}) }
}

function patchItem(item: PullRequestItem, patch: PrPatch | undefined): PullRequestItem {
  if (!patch?.state || item.pr.state === patch.state) return item
  const pr = { ...item.pr, state: patch.state }
  return { ...item, pr, status: classifyPullRequest(pr) }
}

/** The lists with the live patches applied; the same object when nothing applies. */
export function patchLists(lists: CodeHostLists, patchOf: (url: string) => PrPatch | undefined): CodeHostLists {
  let changed = false
  const apply = (items: PullRequestItem[], dropReviewed: boolean): PullRequestItem[] => {
    const out: PullRequestItem[] = []
    for (const item of items) {
      const patch = patchOf(item.pr.url)
      if (!patch) {
        out.push(item)
        continue
      }
      if (dropReviewed && patch.reviewed) {
        changed = true
        continue
      }
      const next = patchItem(item, patch)
      if (next !== item) changed = true
      out.push(next)
    }
    return out
  }
  const mine = apply(lists.mine, false)
  const toReview = apply(lists.toReview, true)
  return changed ? { ...lists, mine, toReview } : lists
}
