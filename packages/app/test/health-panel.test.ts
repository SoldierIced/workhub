import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HEALTH_THRESHOLDS, emptySignals, makeSnapshot, unreachableSnapshot, type HealthEnvironment, type HealthSnapshot } from '@workhub/core'
import type { HealthEnvironmentView } from '../src/shared/health-api'
import { connectionFailure } from '../src/renderer/lib/health'
import { EnvironmentPanel } from '../src/renderer/screens/health/EnvironmentPanel'
import { HealthRowsProvider, type HealthRowActions } from '../src/renderer/screens/health/HealthRows'

const env: HealthEnvironment = {
  id: 'prod',
  name: 'Prod',
  apmEnvironments: ['production'],
  k8sIndexSuffix: 'prod',
  hasKubeState: true,
  apm: { errors: 'logs-apm.error-*', traces: 'traces-apm-*', metrics: 'metrics-apm.internal-*' },
  kibanaUrl: '',
  thresholds: { ...DEFAULT_HEALTH_THRESHOLDS }
}

const view = (snapshot: HealthSnapshot): HealthEnvironmentView => ({
  id: env.id,
  name: env.name,
  snapshot,
  kibanaUrl: null,
  serviceUrls: {},
  errorUrls: {},
  podUrls: {},
  slowFlowHours: env.thresholds.slowFlowHours,
  errorWindowHours: env.thresholds.errorWindowHours,
  thresholds: env.thresholds,
  hasKubeState: env.hasKubeState,
  k8sIndexSuffix: env.k8sIndexSuffix
})

const actions: HealthRowActions = {
  profileId: 'work',
  environmentId: env.id,
  selecting: false,
  isSelected: () => false,
  toggle: () => {},
  busyKey: null,
  investigate: () => {},
  folderHelp: () => ''
}

const render = (snapshot: HealthSnapshot, onRetry?: () => void) =>
  renderToStaticMarkup(createElement(HealthRowsProvider, { value: actions }, createElement(EnvironmentPanel, { env: view(snapshot), onRetry })))

const message = 'Elasticsearch refused the credentials (HTTP 401)'
const read = () => makeSnapshot(env, { ...emptySignals(), podVisibility: 'visible', fastFetchedAt: 1_000, trendFetchedAt: 1_000, slowFetchedAt: 1_000 })

describe('connectionFailure', () => {
  it('is null for an environment that was read', () => {
    expect(connectionFailure(read())).toBeNull()
  })

  it('carries the message, and whether there are earlier figures', () => {
    expect(connectionFailure(unreachableSnapshot(env.id, undefined, message))).toEqual({ message, neverRead: true })
    expect(connectionFailure(unreachableSnapshot(env.id, read(), message))).toEqual({ message, neverRead: false })
  })
})

describe('EnvironmentPanel', () => {
  it('shows a failed first read as an error with its message and a retry, not as empty cards', () => {
    const html = render(unreachableSnapshot(env.id, undefined, message), () => {})
    expect(html).toContain('role="alert"')
    expect(html).toContain(message)
    expect(html).toContain('Try again')
    // The empty cards would read as "nothing wrong" and claim the Kubernetes suffix is missing.
    expect(html).not.toContain('No errors in this window.')
    expect(html).not.toContain('Errors by service')
    // The message is shown once, in the alert, not again as a blind spot.
    expect(html.split(message)).toHaveLength(2)
  })

  it('keeps the last figures under the error when a later read fails', () => {
    const html = render(unreachableSnapshot(env.id, read(), message), () => {})
    expect(html).toContain('role="alert"')
    expect(html).toContain('Errors by service')
  })

  it('shows no failure for an environment that was read', () => {
    const html = render(read(), () => {})
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('Try again')
    expect(html).toContain('Errors by service')
  })
})
