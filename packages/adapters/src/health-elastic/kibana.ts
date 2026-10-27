import type { HealthEnvironment } from '@workhub/core'
import { apmEnvironmentValues } from './queries'

/** Kibana's base URL when it is a usable http(s) one, without a trailing slash. */
export function kibanaBase(raw: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/** The APM overview of one service (`/app/apm/services/<name>/overview`) over the last hours; null without a Kibana URL. */
export function kibanaServiceUrl(env: Pick<HealthEnvironment, 'kibanaUrl' | 'apmEnvironments'>, service: string, lastHours = 24): string | null {
  const base = kibanaBase(env.kibanaUrl)
  if (!base) return null
  const query = new URLSearchParams({ rangeFrom: `now-${lastHours}h`, rangeTo: 'now' })
  const first = apmEnvironmentValues(env)[0]
  if (first) query.set('environment', first)
  return `${base}/app/apm/services/${encodeURIComponent(service)}/overview?${query.toString()}`
}

/** The APM services list of the environment; null without a Kibana URL. */
export function kibanaEnvironmentUrl(env: Pick<HealthEnvironment, 'kibanaUrl' | 'apmEnvironments'>, lastHours = 24): string | null {
  const base = kibanaBase(env.kibanaUrl)
  if (!base) return null
  const query = new URLSearchParams({ rangeFrom: `now-${lastHours}h`, rangeTo: 'now' })
  const first = apmEnvironmentValues(env)[0]
  if (first) query.set('environment', first)
  return `${base}/app/apm/services?${query.toString()}`
}
