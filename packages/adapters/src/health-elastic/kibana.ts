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

/** The APM errors page of a service (`.../services/<name>/errors`); null without a Kibana URL. */
export function kibanaServiceErrorsUrl(env: Pick<HealthEnvironment, 'kibanaUrl' | 'apmEnvironments'>, service: string, lastHours = 24): string | null {
  return kibanaServiceUrl(env, service, lastHours)?.replace('/overview?', '/errors?') ?? null
}

/** The page of one error group (`.../services/<name>/errors/<grouping key>`); null without a Kibana URL. */
export function kibanaErrorGroupUrl(env: Pick<HealthEnvironment, 'kibanaUrl' | 'apmEnvironments'>, service: string, groupingKey: string, lastHours = 24): string | null {
  return kibanaServiceUrl(env, service, lastHours)?.replace('/overview?', `/errors/${encodeURIComponent(groupingKey)}?`) ?? null
}

/**
 * Discover on the default data view, filtered to `field: "value"` over the last hours; null without
 * a Kibana URL. The state is Rison in the fragment: strings in single quotes, `!` and `'` escaped by `!`.
 */
export function kibanaDiscoverUrl(env: Pick<HealthEnvironment, 'kibanaUrl'>, fieldName: string, value: string, lastHours = 24): string | null {
  const base = kibanaBase(env.kibanaUrl)
  if (!base) return null
  const kuery = `${fieldName}:"${value.replace(/"/g, '\\"')}"`
  const rison = kuery.replace(/!/g, '!!').replace(/'/g, "!'")
  return `${base}/app/discover#/?_g=(time:(from:now-${lastHours}h,to:now))&_a=(query:(language:kuery,query:'${encodeURIComponent(rison)}'))`
}
