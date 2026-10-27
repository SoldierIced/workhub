import {
  failureRate,
  serviceOfPod,
  type FlowDetails,
  type HealthThresholds,
  type K8sEvent,
  type PodDetails,
  type PodIssue,
  type SelectedSignals,
  type ServiceErrorCount,
  type ServiceErrorDetails,
  type ServiceReporting,
  type SlowTransaction,
  type TrendStats
} from '@workhub/core'
import { translate, translatePlural, type Locale, type MessageKey, type Params } from '../i18n/translate'
import { formatMs, formatRate } from './health'

/**
 * The drafts "Investigate with Claude" leaves in a new session (Workhub 1's `HealthPrompts`). Each
 * row's draft ends with a request; the combined one ("Investigate together") holds every row's
 * draft without it and asks once at the end. Nothing here is ever sent on its own.
 */

/** What a draft needs to know about the environment. */
export interface PromptEnvironment {
  name: string
  thresholds: Pick<HealthThresholds, 'errorWindowHours' | 'restartWindowMinutes' | 'slowFlowHours'>
}

/** What a row read before its draft was written: the detail, or why it could not be read. */
export interface Read<T> {
  value?: T
  error?: string
}

interface Words {
  t: (key: MessageKey, params?: Params) => string
  n: (value: number) => string
  time: (ms: number) => string
  days: (count: number, truncated?: boolean) => string
}

function words(locale: Locale): Words {
  const numbers = new Intl.NumberFormat(locale)
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  return {
    t: (key, params) => translate(locale, key, params),
    n: (value) => numbers.format(value),
    time: (ms) => dates.format(ms),
    days: (count, truncated = false) => (truncated ? translate(locale, 'healthPrompt.daysPlus', { count }) : translatePlural(locale, 'healthPrompt.days', count))
  }
}

/** "Last 24 h: 2,380 errors, worsening; a typical day over the previous 13 days had about 26." */
function trendLine(w: Words, stats: TrendStats, hours: number, noun: 'errors' | 'events'): string {
  const streak = w.days(stats.streakDays, stats.streakTruncated)
  const state = w.t(`healthPrompt.state.${stats.state}`, { days: streak })
  let text = w.t(`healthPrompt.trend.${noun}`, { hours, count: w.n(stats.recent), state })
  const previous = Math.max(stats.daysWithData - 1, 0)
  if (stats.typicalDay > 0 && previous > 0) text += w.t('healthPrompt.trend.typical', { days: w.days(previous), typical: w.n(stats.typicalDay) })
  return `${text}.`
}

const kibanaLine = (w: Words, url: string | null | undefined) => (url ? `${w.t('healthPrompt.kibana', { url })}\n` : '')
const closing = (w: Words, close: boolean, key: MessageKey = 'healthPrompt.ask') => (close ? w.t(key) : '')

/** How long a service has been silent: 45 min, 3 h, 2 d. */
export function silence(minutes: number): string {
  if (minutes >= 2880) return `${Math.floor(minutes / 1440)} d`
  if (minutes >= 120) return `${Math.floor(minutes / 60)} h`
  return `${minutes} min`
}

export function errorsPrompt(locale: Locale, entry: ServiceErrorCount, details: Read<ServiceErrorDetails>, env: PromptEnvironment, kibana: string | null | undefined, close = true): string {
  const w = words(locale)
  const hours = env.thresholds.errorWindowHours
  let text = `${w.t('healthPrompt.errors.title', { service: entry.service, environment: env.name })}\n${trendLine(w, entry.stats, hours, 'errors')}\n`
  const groups = details.value?.groups ?? []
  if (groups.length > 0) {
    text += `${w.t('healthPrompt.errors.groups', { hours })}\n`
    groups.forEach((g, i) => {
      let line = w.t('healthPrompt.errors.group', { position: i + 1, type: g.exceptionType ?? g.culprit ?? g.groupingKey, count: w.n(g.recent) })
      if (g.endpoint) line += w.t('healthPrompt.errors.endpoint', { endpoint: g.endpoint })
      if (g.firstSeen !== undefined) {
        line += w.t('healthPrompt.errors.firstSeen', { time: w.time(g.firstSeen) })
        if (g.isNew) line += w.t('healthPrompt.errors.new')
      }
      if (g.lastSeen !== undefined) line += w.t('healthPrompt.errors.lastSeen', { time: w.time(g.lastSeen) })
      text += `${line}.\n`
      if (g.message) text += `${w.t('healthPrompt.errors.message', { text: g.message })}\n`
      if (g.culprit) text += `${w.t('healthPrompt.errors.culprit', { text: g.culprit })}\n`
    })
  } else if (details.error) {
    text += `${w.t('healthPrompt.errors.unread', { error: details.error })}\n`
  }
  return text + kibanaLine(w, kibana) + closing(w, close)
}

export function silentPrompt(locale: Locale, service: ServiceReporting, errors: ServiceErrorCount | undefined, env: PromptEnvironment, kibana: string | null | undefined, close = true): string {
  const w = words(locale)
  let text = `${w.t('healthPrompt.silent.title', { service: service.service, environment: env.name })}\n${w.t('healthPrompt.silent.since', { silence: silence(service.silentMinutes), time: w.time(service.lastSeen) })}\n`
  if (errors) text += `${w.t('healthPrompt.silent.before', { trend: trendLine(w, errors.stats, env.thresholds.errorWindowHours, 'errors') })}\n`
  return `${text}${kibanaLine(w, kibana)}${w.t('healthPrompt.silent.hint')}${close ? ` ${w.t('healthPrompt.ask')}` : ''}`
}

export function podPrompt(locale: Locale, pod: PodIssue, details: Read<PodDetails>, env: PromptEnvironment, kibana: string | null | undefined, close = true): string {
  const w = words(locale)
  const hours = env.thresholds.errorWindowHours
  const status = details.value?.status
  let text = `${w.t('healthPrompt.pod.title', { pod: pod.pod, service: serviceOfPod(pod.pod, status?.container), environment: env.name })}\n`
  const state: string[] = []
  if (pod.notReady) state.push(w.t('healthPrompt.pod.notReady'))
  if (pod.backOff) state.push(w.t('healthPrompt.pod.backOff'))
  if (pod.recentRestarts > 0) state.push(w.t('healthPrompt.pod.recentRestarts', { count: pod.recentRestarts, minutes: env.thresholds.restartWindowMinutes }))
  if (pod.restarts > 0) state.push(w.t('healthPrompt.pod.restarts', { count: pod.restarts }))
  if (status?.waitingReason) state.push(w.t('healthPrompt.pod.waiting', { reason: status.waitingReason }))
  if (status?.lastTerminatedReason) {
    let ended = w.t('healthPrompt.pod.ended', { reason: status.lastTerminatedReason })
    if (status.lastExitCode !== undefined) ended += w.t('healthPrompt.pod.exitCode', { code: status.lastExitCode })
    if (status.lastTerminatedAt !== undefined) ended += w.t('healthPrompt.pod.endedAt', { time: w.time(status.lastTerminatedAt) })
    state.push(ended)
  }
  if (state.length > 0) text += `${w.t('healthPrompt.pod.state', { parts: state.join('; ') })}\n`
  const d = details.value
  if (d) {
    if (d.eventsError) text += `${w.t('healthPrompt.pod.eventsUnread', { error: d.eventsError })}\n`
    else if (d.events.length === 0) text += `${w.t('healthPrompt.pod.noEvents', { hours })}\n`
    else {
      text += `${w.t('healthPrompt.pod.events', { hours })}\n`
      for (const e of d.events) {
        let line = `- ${e.reason}`
        if (e.lastSeen !== undefined) line += `, ${w.time(e.lastSeen)}`
        line += `, ${w.t('healthPrompt.pod.times', { count: w.n(Math.max(e.occurrences ?? 0, e.count)) })}`
        if (e.message) line += `: ${e.message}`
        text += `${line}\n`
      }
    }
    if (d.stderrError) text += `${w.t('healthPrompt.pod.stderrUnread', { error: d.stderrError })}\n`
    else if (d.stderr.length > 0) text += `${w.t('healthPrompt.pod.stderr')}\n${d.stderr.map((l) => `    ${l.text}`).join('\n')}\n`
  } else if (details.error) {
    text += `${w.t('healthPrompt.pod.unread', { error: details.error })}\n`
  }
  return text + kibanaLine(w, kibana) + closing(w, close)
}

export function eventPrompt(locale: Locale, event: K8sEvent, env: PromptEnvironment, close = true): string {
  const w = words(locale)
  let latest = w.t('healthPrompt.event.latest')
  if (event.lastSeen !== undefined) latest += `, ${w.time(event.lastSeen)}`
  if (event.object) latest += w.t('healthPrompt.event.about', { object: `${event.objectKind ? `${event.objectKind} ` : ''}${event.object}` })
  if (event.message) latest += `: ${event.message}`
  return `${w.t('healthPrompt.event.title', { reason: event.reason, environment: env.name })}\n${trendLine(w, event.stats, env.thresholds.errorWindowHours, 'events')}\n${latest}\n${closing(w, close)}`
}

export function flowPrompt(locale: Locale, tx: SlowTransaction, details: Read<FlowDetails>, env: PromptEnvironment, kibana: string | null | undefined, close = true): string {
  const w = words(locale)
  const hours = env.thresholds.slowFlowHours
  let stats = w.t('healthPrompt.flow.stats', { hours, calls: w.n(tx.calls), p50: formatMs(tx.p50Ms), p95: formatMs(tx.p95Ms), p99: formatMs(tx.p99Ms) })
  if (tx.failureRate > 0) stats += w.t('healthPrompt.flow.failed', { rate: formatRate(tx.failureRate) })
  let text = `${w.t('healthPrompt.flow.title', { name: tx.name, service: tx.service, environment: env.name })}\n${stats}.\n`
  const d = details.value
  if (d && d.spans.length > 0) {
    text += `${w.t('healthPrompt.flow.spans', { count: d.sampledTransactions })}\n`
    for (const s of d.spans.slice(0, 5)) {
      text += `${w.t('healthPrompt.flow.span', {
        resource: s.resource,
        kind: [s.type, s.subtype].filter(Boolean).join(' · '),
        total: formatMs(s.totalMs),
        average: formatMs(s.averageMs),
        perRequest: s.callsPerTransaction.toFixed(1),
        share: formatRate(s.shareOfWallTime)
      })}\n`
    }
  }
  const c = d?.comparison
  if (c && c.previous.transactions + c.current.transactions > 0) {
    const ms = (v: number | undefined) => (v === undefined ? '–' : formatMs(v))
    text += `${w.t('healthPrompt.flow.compared', {
      hours: c.windowHours,
      p95Before: ms(c.previous.p95Ms),
      p95After: ms(c.current.p95Ms),
      errorsBefore: w.n(c.previous.errors),
      errorsAfter: w.n(c.current.errors),
      failedBefore: formatRate(failureRate(c.previous)),
      failedAfter: formatRate(failureRate(c.current))
    })}\n`
    if (c.newErrorTypes.length > 0) text += `${w.t('healthPrompt.flow.newTypes', { hours: c.windowHours, types: c.newErrorTypes.map((n) => n.exceptionType ?? n.culprit ?? n.groupingKey).join(', ') })}\n`
  }
  return text + kibanaLine(w, kibana) + closing(w, close, 'healthPrompt.flow.ask')
}

/** What the combined draft needs besides the selected rows. */
export interface TogetherContext {
  env: PromptEnvironment
  profileName: string
  /** Set when the session opens outside a single repository: the draft names the ones involved. */
  involved?: { repositories: string[]; unmatched: string[] }
  errors: Record<string, Read<ServiceErrorDetails>>
  pods: Record<string, Read<PodDetails>>
  flows: Record<string, Read<FlowDetails>>
  /** All error counts of the environment, for the silent services that had some before going quiet. */
  errorServices: ServiceErrorCount[]
  links: { errors: Record<string, string>; pods: Record<string, string>; services: Record<string, string> }
}

/**
 * One draft for every selected row: a header, then a numbered section per row with the very text
 * its own "Investigate with Claude" would leave (minus its closing request, asked once at the end).
 */
export function togetherPrompt(locale: Locale, s: SelectedSignals, c: TogetherContext): string {
  const w = words(locale)
  const count = s.errors.length + s.silent.length + s.pods.length + s.events.length + s.flows.length
  let text = `${translatePlural(locale, 'healthPrompt.together.title', count, { environment: c.env.name, profile: c.profileName })}\n`
  if (c.involved?.repositories.length) text += `${w.t('healthPrompt.together.repositories', { names: c.involved.repositories.join(', ') })}\n`
  if (c.involved?.unmatched.length) text += `${w.t('healthPrompt.together.unmatched', { names: c.involved.unmatched.join(', ') })}\n`
  const timedOut = w.t('healthPrompt.together.timedOut')
  const orTimedOut = <T>(read: Read<T> | undefined): Read<T> => read ?? { error: timedOut }
  const sections: [string, string][] = [
    ...s.errors.map((e): [string, string] => [w.t('healthPrompt.together.errors', { service: e.service }), errorsPrompt(locale, e, orTimedOut(c.errors[e.service]), c.env, c.links.errors[e.service], false)]),
    ...s.silent.map((x): [string, string] => [
      w.t('healthPrompt.together.silent', { service: x.service }),
      silentPrompt(locale, x, c.errorServices.find((e) => e.service === x.service), c.env, c.links.services[x.service], false)
    ]),
    ...s.pods.map((p): [string, string] => [w.t('healthPrompt.together.pod', { pod: p.pod }), podPrompt(locale, p, orTimedOut(c.pods[p.pod]), c.env, c.links.pods[p.pod], false)]),
    ...s.events.map((e): [string, string] => [w.t('healthPrompt.together.event', { reason: e.reason }), eventPrompt(locale, e, c.env, false)]),
    ...s.flows.map((tx): [string, string] => [
      w.t('healthPrompt.together.flow', { name: tx.name, service: tx.service }),
      flowPrompt(locale, tx, c.flows[`${tx.service}|${tx.name}`] ?? {}, c.env, c.links.services[tx.service], false)
    ])
  ]
  sections.forEach(([title, body], i) => {
    text += `\n## ${i + 1}. ${title}\n${body.trim()}\n`
  })
  return `${text}\n${w.t('healthPrompt.together.ask')}`
}
