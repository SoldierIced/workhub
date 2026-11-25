import { loadDetail } from './prDetailCache'
import { recordPatch, type PrPatch } from './prPatches'
import { refreshPullRequests } from '../pullRequestsStore'

/**
 * After the host confirmed a write: patch what the screens show at once (`change`), then read the PR and the
 * lists again in the background. Nothing here is awaited: the dialog that asked has already closed.
 */
export function afterPullRequestWrite(profileId: string | null, url: string, change?: Omit<PrPatch, 'at'>): void {
  if (change) recordPatch(url, change)
  void refreshPullRequests(profileId, true)
  void loadDetail(profileId, url, true)
}
