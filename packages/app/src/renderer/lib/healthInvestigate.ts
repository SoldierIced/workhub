import {
  flowKey,
  folderForEvent,
  folderForPod,
  investigationTargets,
  involvedRepositories,
  matchFolder,
  selectedSignals,
  sharedFolder,
  signalCount,
  type FlowDetails,
  type HealthDetailRequest,
  type HealthItemId,
  type HealthSnapshot,
  type K8sEvent,
  type PodDetails,
  type PodIssue,
  type ServiceErrorCount,
  type ServiceErrorDetails,
  type ServiceReporting,
  type SlowTransaction
} from '@workhub/core'
import type { HealthDetail, HealthDetailResult, HealthEnvironmentView } from '@shared/health-api'
import type { Locale } from '../i18n/translate'
import { errorsPrompt, eventPrompt, flowPrompt, podPrompt, silentPrompt, togetherPrompt, type Read } from './healthPrompts'

/**
 * "Investigate with Claude" for every kind of row, as Workhub 1 does it: read what the row still
 * lacks (error groups, a pod's events and stderr, a flow's spans), write the draft, and pick the
 * folder of the service's repository. The caller opens the session; nothing is ever sent.
 */

export type HealthRow =
  | { kind: 'errors'; entry: ServiceErrorCount }
  | { kind: 'silent'; service: ServiceReporting }
  | { kind: 'pod'; pod: PodIssue }
  | { kind: 'event'; event: K8sEvent }
  | { kind: 'flow'; tx: SlowTransaction }

export interface InvestigateDeps {
  locale: Locale
  /** The profile's folders (absolute paths). */
  folders: string[]
  profileName: string
  env: HealthEnvironmentView
  details: (request: HealthDetailRequest) => Promise<HealthDetailResult>
  /** How long "Investigate together" waits for the details; what did not arrive is named as timed out. */
  timeoutMs?: number
}

/** The draft and the folder to open it in; no folder means the profile's first one. */
export interface Investigation {
  draft: string
  folder?: string
}

async function read<T extends HealthDetail>(deps: InvestigateDeps, request: HealthDetailRequest): Promise<Read<T>> {
  try {
    const r = await deps.details(request)
    return r.ok ? { value: r.value as T } : { error: r.error }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

const promptEnv = (env: HealthEnvironmentView) => ({ name: env.name, thresholds: env.thresholds })

export async function investigateRow(row: HealthRow, deps: InvestigateDeps): Promise<Investigation> {
  const { locale, folders, env } = deps
  const pe = promptEnv(env)
  switch (row.kind) {
    case 'errors': {
      const details = await read<ServiceErrorDetails>(deps, { kind: 'errors', service: row.entry.service })
      return { draft: errorsPrompt(locale, row.entry, details, pe, env.errorUrls[row.entry.service]), folder: matchFolder(folders, row.entry.service) }
    }
    case 'silent': {
      const errors = env.snapshot.errorServices.find((e) => e.service === row.service.service)
      return { draft: silentPrompt(locale, row.service, errors, pe, env.serviceUrls[row.service.service]), folder: matchFolder(folders, row.service.service) }
    }
    case 'pod': {
      const details = await read<PodDetails>(deps, { kind: 'pod', pod: row.pod.pod })
      return { draft: podPrompt(locale, row.pod, details, pe, env.podUrls[row.pod.pod]), folder: folderForPod(folders, row.pod.pod, details.value?.status?.container) }
    }
    case 'event':
      return { draft: eventPrompt(locale, row.event, pe), folder: folderForEvent(folders, row.event) }
    case 'flow': {
      const details = await read<FlowDetails>(deps, { kind: 'flow', service: row.tx.service, name: row.tx.name })
      return { draft: flowPrompt(locale, row.tx, details, pe, env.serviceUrls[row.tx.service]), folder: matchFolder(folders, row.tx.service) }
    }
  }
}

/** Resolves to `undefined` when `ms` passes first. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

/**
 * One draft for every selected row. The details still missing are read in parallel and waited for
 * at most `timeoutMs`. The session opens in the one folder every row maps to; otherwise in the
 * profile's first folder, with the draft naming the repositories involved.
 */
export async function investigateTogether(selection: ReadonlySet<HealthItemId>, snapshot: HealthSnapshot, deps: InvestigateDeps): Promise<Investigation | null> {
  const signals = selectedSignals(selection, snapshot)
  if (signalCount(signals) === 0) return null
  const timeout = deps.timeoutMs ?? 15_000
  const collect = async <T extends HealthDetail>(keys: string[], request: (key: string) => HealthDetailRequest) => {
    const answers = await Promise.all(keys.map((k) => within(read<T>(deps, request(k)), timeout)))
    const out: Record<string, Read<T>> = {}
    keys.forEach((k, i) => {
      const answer = answers[i]
      if (answer) out[k] = answer
    })
    return out
  }
  const [errors, pods, flows] = await Promise.all([
    collect<ServiceErrorDetails>(
      signals.errors.map((e) => e.service),
      (service) => ({ kind: 'errors', service })
    ),
    collect<PodDetails>(
      signals.pods.map((p) => p.pod),
      (pod) => ({ kind: 'pod', pod })
    ),
    collect<FlowDetails>(signals.flows.map(flowKey), (key) => {
      const tx = signals.flows.find((f) => flowKey(f) === key)!
      return { kind: 'flow', service: tx.service, name: tx.name }
    })
  ])
  const containers = Object.fromEntries(Object.entries(pods).map(([pod, r]) => [pod, r.value?.status?.container]))
  const targets = investigationTargets(signals, deps.folders, containers)
  const folder = sharedFolder(targets)
  const draft = togetherPrompt(deps.locale, signals, {
    env: promptEnv(deps.env),
    profileName: deps.profileName,
    involved: folder ? undefined : involvedRepositories(targets),
    errors,
    pods,
    flows,
    errorServices: snapshot.errorServices,
    links: { errors: deps.env.errorUrls, pods: deps.env.podUrls, services: deps.env.serviceUrls }
  })
  return { draft, folder }
}
