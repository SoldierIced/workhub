import {
  DEFAULT_HEALTH_THRESHOLDS,
  ELASTIC_STOCK_APM,
  HEALTH_CONNECTION_SETTINGS,
  type Connection,
  type HealthAuthMode,
  type HealthEnvironment,
  type HealthThresholds,
  type HealthTlsMode
} from '@workhub/core'

/** Settings → Health form state: plain strings and booleans, converted to and from the stored shapes. */
export interface EnvironmentForm {
  id: string
  name: string
  /** Comma separated `service.environment` values. */
  values: string
  errors: string
  traces: string
  metrics: string
  k8sSuffix: string
  kubeState: boolean
  kibana: string
  thresholds: HealthThresholds
}

export interface ConnectionForm {
  id: string | null
  url: string
  auth: HealthAuthMode
  username: string
  secret: string
  tls: HealthTlsMode
  fingerprint: string
}

export const emptyConnectionForm = (): ConnectionForm => ({ id: null, url: '', auth: 'apiKey', username: '', secret: '', tls: 'system', fingerprint: '' })

export function connectionToForm(c: Connection | undefined): ConnectionForm {
  if (!c) return emptyConnectionForm()
  const s = c.settings
  const tls = s[HEALTH_CONNECTION_SETTINGS.tls]
  return {
    id: c.id,
    url: c.endpoint ?? '',
    auth: s[HEALTH_CONNECTION_SETTINGS.auth] === 'basic' ? 'basic' : 'apiKey',
    username: s[HEALTH_CONNECTION_SETTINGS.username] ?? '',
    secret: '',
    tls: tls === 'pinned' || tls === 'insecure' ? tls : 'system',
    fingerprint: s[HEALTH_CONNECTION_SETTINGS.fingerprint] ?? ''
  }
}

/** The connection a form describes. Settings that do not apply to the chosen modes are left out. */
export function formToConnection(form: ConnectionForm, id: string): Connection {
  const settings: Record<string, string> = {}
  if (form.auth === 'basic') {
    settings[HEALTH_CONNECTION_SETTINGS.auth] = 'basic'
    settings[HEALTH_CONNECTION_SETTINGS.username] = form.username.trim()
  }
  if (form.tls !== 'system') settings[HEALTH_CONNECTION_SETTINGS.tls] = form.tls
  if (form.tls === 'pinned') settings[HEALTH_CONNECTION_SETTINGS.fingerprint] = form.fingerprint.trim()
  return { id, kind: 'health', provider: 'elastic-apm', name: 'Elasticsearch', endpoint: form.url.trim(), settings }
}

/** Names a stable key for an environment: lowercase words joined by dashes. */
export function environmentId(name: string, taken: readonly string[]): string {
  const root = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'environment'
  if (!taken.includes(root)) return root
  for (let i = 2; ; i++) if (!taken.includes(`${root}-${i}`)) return `${root}-${i}`
}

export const splitValues = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean)

export function emptyEnvironment(taken: readonly string[]): EnvironmentForm {
  return { id: environmentId('environment', taken), name: '', values: '', errors: '', traces: '', metrics: '', k8sSuffix: '', kubeState: false, kibana: '', thresholds: { ...DEFAULT_HEALTH_THRESHOLDS } }
}

export function environmentToForm(e: HealthEnvironment): EnvironmentForm {
  return {
    id: e.id,
    name: e.name,
    values: e.apmEnvironments.join(', '),
    errors: e.apm.errors,
    traces: e.apm.traces,
    metrics: e.apm.metrics,
    k8sSuffix: e.k8sIndexSuffix,
    kubeState: e.hasKubeState,
    kibana: e.kibanaUrl,
    thresholds: { ...e.thresholds }
  }
}

export function formToEnvironment(f: EnvironmentForm): HealthEnvironment {
  return {
    id: f.id,
    name: f.name.trim(),
    apmEnvironments: splitValues(f.values),
    k8sIndexSuffix: f.k8sSuffix.trim(),
    hasKubeState: f.kubeState,
    apm: { errors: f.errors.trim(), traces: f.traces.trim(), metrics: f.metrics.trim() },
    kibanaUrl: f.kibana.trim(),
    thresholds: f.thresholds
  }
}

/** Elastic's stock APM data streams, offered as a starting point. */
export const withStockIndices = (f: EnvironmentForm): EnvironmentForm => ({ ...f, ...ELASTIC_STOCK_APM })
