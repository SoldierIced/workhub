import { useEffect, useState } from 'react'
import { canonicalUrl, type PullRequestItem, type TicketKeyProvider } from '@workhub/core'
import { keyProviders } from './tickets'
import { ticketPreviews, type TicketPreview } from './ticketPreview'

/**
 * What the session monitor reads beyond the session itself: the profile's ticket keys, the pull
 * requests the session named that are in neither list, and its tickets' titles and statuses.
 * Each is read once and shared by every open monitor.
 */

const providersByProfile = new Map<string, Promise<TicketKeyProvider[]>>()

/** The profile's tracker as ticket key providers; empty when none is connected (any key then counts). */
export function useTicketProviders(profileId: string | null): TicketKeyProvider[] {
  const [providers, setProviders] = useState<TicketKeyProvider[]>([])
  useEffect(() => {
    let alive = true
    const key = profileId ?? ''
    let read = providersByProfile.get(key)
    if (!read) {
      read = window.hub.tickets.status(profileId).then(keyProviders, () => [])
      providersByProfile.set(key, read)
    }
    void read.then((p) => alive && setProviders(p))
    return () => {
      alive = false
    }
  }, [profileId])
  return providers
}

/** How many named PRs outside the lists are read, the most recently named first. */
export const MENTIONED_PR_READS = 10

/** The PRs the session named that the lists do not hold, read from the host by URL (`null` when it cannot be read). */
export function usePullRequestsByUrl(profileId: string | null, mentioned: readonly string[] | undefined, known: readonly PullRequestItem[]): PullRequestItem[] {
  const [read, setRead] = useState<Record<string, PullRequestItem | null>>({})
  const knownUrls = new Set(known.map((i) => canonicalUrl(i.pr.url)))
  const wanted = [...new Set([...(mentioned ?? [])].reverse().map(canonicalUrl))].filter((u) => !knownUrls.has(u)).slice(0, MENTIONED_PR_READS)
  const signature = `${profileId ?? ''}|${wanted.join(' ')}`
  useEffect(() => {
    let alive = true
    for (const url of wanted) {
      void window.hub.codeHost.pullRequest(profileId, url).then(
        (item) => alive && setRead((r) => (url in r && r[url] === item ? r : { ...r, [url]: item })),
        () => alive && setRead((r) => ({ ...r, [url]: null }))
      )
    }
    return () => {
      alive = false
    }
    // `signature` stands for `wanted` and the profile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
  return wanted.map((u) => read[u]).filter((i): i is PullRequestItem => !!i)
}

/** Title and status of each ticket, read from the tracker (shared with the PR ticket chips' hover cards). */
export function useTicketPreviews(profileId: string | null, keys: readonly string[]): Record<string, TicketPreview> {
  const [previews, setPreviews] = useState<Record<string, TicketPreview>>({})
  const signature = `${profileId ?? ''}|${keys.join(' ')}`
  useEffect(() => {
    if (!profileId) return
    let alive = true
    for (const key of keys) {
      void ticketPreviews()
        .load(profileId, key)
        .then((p) => alive && setPreviews((all) => (all[key] === p ? all : { ...all, [key]: p })))
    }
    return () => {
      alive = false
    }
    // `signature` stands for the keys and the profile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
  return previews
}
