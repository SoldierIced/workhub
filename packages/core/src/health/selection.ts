import type { HealthSnapshot, K8sEvent, PodIssue, ServiceErrorCount, ServiceReporting, SlowTransaction } from './types'

/**
 * "Select" on the Health screen: rows of every list can be picked and investigated together in one
 * session. Rows are named by what the environment calls them, so a selection only means something
 * in the environment it was made in. Everything here is pure; the screen keeps the state.
 */

export type HealthItemKind = 'errors' | 'silent' | 'pod' | 'event' | 'flow'

/** `<kind>:<key>`: the service, pod, warning reason, or `service|name` of a flow. */
export type HealthItemId = string

export const itemId = (kind: HealthItemKind, key: string): HealthItemId => `${kind}:${key}`
export const flowKey = (tx: Pick<SlowTransaction, 'service' | 'name'>): string => `${tx.service}|${tx.name}`

/** Every row the snapshot offers, in the order the screen lists them. */
export function selectableItems(snapshot: Pick<HealthSnapshot, 'errorServices' | 'silentServices' | 'pods' | 'events' | 'slow'>): HealthItemId[] {
  return [
    ...snapshot.errorServices.map((e) => itemId('errors', e.service)),
    ...snapshot.pods.map((p) => itemId('pod', p.pod)),
    ...snapshot.events.map((e) => itemId('event', e.reason)),
    ...snapshot.silentServices.map((s) => itemId('silent', s.service)),
    ...snapshot.slow.map((tx) => itemId('flow', flowKey(tx)))
  ]
}

export function toggleItem(selection: ReadonlySet<HealthItemId>, id: HealthItemId): Set<HealthItemId> {
  const next = new Set(selection)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** A row a refresh dropped cannot stay selected. Returns the same set when nothing changed. */
export function pruneSelection(selection: ReadonlySet<HealthItemId>, selectable: readonly HealthItemId[]): ReadonlySet<HealthItemId> {
  const offered = new Set(selectable)
  if ([...selection].every((id) => offered.has(id))) return selection
  return new Set([...selection].filter((id) => offered.has(id)))
}

/** The selected rows resolved against the snapshot, in screen order. */
export interface SelectedSignals {
  errors: ServiceErrorCount[]
  silent: ServiceReporting[]
  pods: PodIssue[]
  events: K8sEvent[]
  flows: SlowTransaction[]
}

export function selectedSignals(selection: ReadonlySet<HealthItemId>, snapshot: Pick<HealthSnapshot, 'errorServices' | 'silentServices' | 'pods' | 'events' | 'slow'>): SelectedSignals {
  return {
    errors: snapshot.errorServices.filter((e) => selection.has(itemId('errors', e.service))),
    silent: snapshot.silentServices.filter((s) => selection.has(itemId('silent', s.service))),
    pods: snapshot.pods.filter((p) => selection.has(itemId('pod', p.pod))),
    events: snapshot.events.filter((e) => selection.has(itemId('event', e.reason))),
    flows: snapshot.slow.filter((tx) => selection.has(itemId('flow', flowKey(tx))))
  }
}

export const signalCount = (s: SelectedSignals): number => s.errors.length + s.silent.length + s.pods.length + s.events.length + s.flows.length

// Which repository a row belongs to ------------------------------------------------------------

/** The folder's name: the last segment of its path. */
export const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The profile folder named like the service (case and separators ignored); undefined when none is. */
export function matchFolder(folders: readonly string[], service: string): string | undefined {
  const wanted = normalized(service)
  if (!wanted) return undefined
  return folders.find((f) => normalized(folderName(f)) === wanted)
}

const GENERATED = new Set('bcdfghjklmnpqrstvwxz2456789')

/** Generated suffixes are digits only (ordinals, job timestamps) or 5 to 10 characters of Kubernetes' vowel-less alphabet. */
function isGenerated(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true
  return segment.length >= 5 && segment.length <= 10 && [...segment].every((c) => GENERATED.has(c))
}

/** "orders-api-7f9c5d-xk2lp" -> "orders-api", "ledger-0" -> "ledger": drops at most two generated trailing segments. */
export function workloadName(pod: string): string {
  const parts = pod.split('-')
  let dropped = 0
  while (dropped < 2 && parts.length > 1 && isGenerated(parts[parts.length - 1]!)) {
    parts.pop()
    dropped++
  }
  return parts.join('-')
}

/** The service a pod runs, for the draft: its container's name, else its workload name. */
export const serviceOfPod = (pod: string, container?: string): string => container || workloadName(pod)

/** A pod's folder: its container's name, its workload name, then the longest folder name it starts with. */
export function folderForPod(folders: readonly string[], pod: string, container?: string): string | undefined {
  for (const name of [container, workloadName(pod)]) {
    const folder = name ? matchFolder(folders, name) : undefined
    if (folder) return folder
  }
  const lowered = pod.toLowerCase()
  return folders
    .filter((f) => lowered.startsWith(`${folderName(f).toLowerCase()}-`))
    .sort((a, b) => folderName(b).length - folderName(a).length)[0]
}

/** A warning event's folder: the one of the pod (or other object) its latest occurrence is about. */
export const folderForEvent = (folders: readonly string[], event: Pick<K8sEvent, 'object'>): string | undefined => (event.object ? folderForPod(folders, event.object) : undefined)

/** The service a row is about, when it names one, and the folder of that service's repository. */
export interface InvestigationTarget {
  service?: string
  folder?: string
}

export function investigationTargets(s: SelectedSignals, folders: readonly string[], containers: Record<string, string | undefined> = {}): InvestigationTarget[] {
  return [
    ...s.errors.map((e) => ({ service: e.service, folder: matchFolder(folders, e.service) })),
    ...s.silent.map((e) => ({ service: e.service, folder: matchFolder(folders, e.service) })),
    ...s.pods.map((p) => ({ service: serviceOfPod(p.pod, containers[p.pod]), folder: folderForPod(folders, p.pod, containers[p.pod]) })),
    ...s.events.map((e) => ({ service: e.object ? workloadName(e.object) : undefined, folder: folderForEvent(folders, e) })),
    ...s.flows.map((tx) => ({ service: tx.service, folder: matchFolder(folders, tx.service) }))
  ]
}

/** The one folder every row maps to; undefined when they map to several or any maps to none. */
export function sharedFolder(targets: readonly InvestigationTarget[]): string | undefined {
  const first = targets[0]?.folder
  return first && targets.every((t) => t.folder === first) ? first : undefined
}

/** The repositories the rows belong to, and the services without a folder in the profile. */
export function involvedRepositories(targets: readonly InvestigationTarget[]): { repositories: string[]; unmatched: string[] } {
  const repositories: string[] = []
  const unmatched: string[] = []
  for (const t of targets) {
    if (t.folder) {
      const name = folderName(t.folder)
      if (!repositories.includes(name)) repositories.push(name)
    } else if (t.service && !unmatched.includes(t.service)) unmatched.push(t.service)
  }
  return { repositories, unmatched }
}
