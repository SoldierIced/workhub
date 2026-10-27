import { describe, expect, it } from 'vitest'
import type { PrEvent } from '@workhub/core'
import { blindSpotText, folderForService, formatMs, formatRate, reasonText, visibleBlindSpots } from '../src/renderer/lib/health'
import { environmentId, formToConnection, formToEnvironment, connectionToForm, emptyConnectionForm, splitValues, environmentToForm, emptyEnvironment } from '../src/renderer/lib/healthForm'
import { isNotifiable, prNotificationText } from '../src/renderer/lib/prEvents'
import { onComposerDraft, setComposerDraft, takeComposerDraft } from '../src/renderer/lib/drafts'
import { translate, translatePlural } from '../src/renderer/i18n/translate'
import { DEFAULT_PR_EVENT_TOGGLES } from '@workhub/core'

const i18n = (locale: 'en' | 'es') => ({ t: (k: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate(locale, k, p), tn: (b: Parameters<typeof translatePlural>[1], n: number, p?: Parameters<typeof translatePlural>[3]) => translatePlural(locale, b, n, p) })

describe('health formatting', () => {
  it('formats latencies and rates', () => {
    expect(formatMs(540)).toBe('540 ms')
    expect(formatMs(2310)).toBe('2.3 s')
    expect(formatMs(41_000)).toBe('41 s')
    expect(formatRate(0.031)).toBe('3.1%')
    expect(formatRate(0.2)).toBe('20%')
    expect(formatRate(0)).toBe('0%')
  })
  it('words reasons and blind spots in both languages', () => {
    expect(reasonText({ code: 'podsNotReady', count: 1 }, i18n('en').tn)).toBe('1 pod not ready')
    expect(reasonText({ code: 'podsNotReady', count: 3 }, i18n('es').tn)).toBe('3 pods no listos')
    expect(blindSpotText({ code: 'unread', signal: 'slow', detail: 'timed out' }, i18n('en').t)).toBe('Slow endpoints could not be read: timed out')
    expect(blindSpotText({ code: 'apmOff' }, i18n('es').t)).toContain('service.environment')
  })
  it('hides the pod blind spots the Pods card already explains', () => {
    expect(visibleBlindSpots([{ code: 'noKubeState' }, { code: 'apmOff' }, { code: 'noPodMetrics' }]).map((b) => b.code)).toEqual(['apmOff'])
  })
})

describe('folderForService', () => {
  const folders = ['/home/dev/code/storefront', 'C:\\work\\checkout-api', '/srv/misc']
  it('prefers the folder named like the service, ignoring case and separators', () => {
    expect(folderForService(folders, 'Checkout_API')).toBe('C:\\work\\checkout-api')
    expect(folderForService(folders, 'storefront')).toBe('/home/dev/code/storefront')
  })
  it('falls back to the first folder, or nothing', () => {
    expect(folderForService(folders, 'unknown-service')).toBe('/home/dev/code/storefront')
    expect(folderForService([], 'x')).toBeUndefined()
  })
})

describe('Health form conversions', () => {
  it('round-trips an environment', () => {
    const form = { ...emptyEnvironment([]), name: ' Prod ', values: 'prod, production,, ', errors: 'e-*', k8sSuffix: ' prod ', kubeState: true, kibana: ' https://k.example.test ' }
    const env = formToEnvironment(form)
    expect(env).toMatchObject({ name: 'Prod', apmEnvironments: ['prod', 'production'], k8sIndexSuffix: 'prod', hasKubeState: true, kibanaUrl: 'https://k.example.test', apm: { errors: 'e-*', traces: '', metrics: '' } })
    expect(environmentToForm(env).values).toBe('prod, production')
  })
  it('stores only the connection settings that apply', () => {
    expect(formToConnection({ ...emptyConnectionForm(), url: ' https://es.example.test ' }, 'es')).toEqual({ id: 'es', kind: 'health', provider: 'elastic-apm', name: 'Elasticsearch', endpoint: 'https://es.example.test', settings: {} })
    const basic = formToConnection({ ...emptyConnectionForm(), url: 'https://es.example.test', auth: 'basic', username: ' reader ', tls: 'pinned', fingerprint: 'AA:BB' }, 'es')
    expect(basic.settings).toEqual({ auth: 'basic', username: 'reader', tls: 'pinned', tlsFingerprint: 'AA:BB' })
    expect(connectionToForm(basic)).toMatchObject({ auth: 'basic', username: 'reader', tls: 'pinned', fingerprint: 'AA:BB', secret: '' })
  })
  it('makes stable unique environment ids', () => {
    expect(environmentId('Develop (EU)', [])).toBe('develop-eu')
    expect(environmentId('Develop', ['develop'])).toBe('develop-2')
    expect(environmentId('***', [])).toBe('environment')
    expect(splitValues('a, b\nc,,')).toEqual(['a', 'b', 'c'])
  })
})

describe('pull request notification text', () => {
  const event = (over: Partial<PrEvent>): PrEvent => ({ id: 'x', kind: 'approved', url: 'https://github.com/acme/api/pull/7', title: 'Add retries', name: 'api#7', at: 1, ...over })
  it('words each kind in English and Spanish', () => {
    expect(prNotificationText(event({}), i18n('en'))).toEqual({ title: 'Approved · api#7', body: 'Add retries' })
    expect(prNotificationText(event({ kind: 'ciFailed' }), i18n('es')).title).toBe('Falló el CI · api#7')
    expect(prNotificationText(event({ kind: 'reviewRequested', actor: 'sam' }), i18n('en')).body).toBe('By sam: Add retries')
    expect(prNotificationText(event({ kind: 'newComments', count: 1 }), i18n('en')).title).toBe('1 new comment · api#7')
    expect(prNotificationText(event({ kind: 'newComments', count: 3 }), i18n('es')).title).toBe('3 comentarios nuevos · api#7')
  })
  it('notifies only the kinds Settings allows', () => {
    expect(isNotifiable(event({ kind: 'approved' }), DEFAULT_PR_EVENT_TOGGLES)).toBe(true)
    expect(isNotifiable(event({ kind: 'ciPassed' }), DEFAULT_PR_EVENT_TOGGLES)).toBe(false)
    expect(isNotifiable(event({ kind: 'merged' }), { ...DEFAULT_PR_EVENT_TOGGLES, merged: false })).toBe(false)
    expect(isNotifiable(event({ kind: 'bogus' as never }), DEFAULT_PR_EVENT_TOGGLES)).toBe(false)
  })
})

describe('composer drafts', () => {
  it('hands a draft to its session once, never to another', () => {
    const seen: string[] = []
    const off = onComposerDraft((id) => seen.push(id))
    setComposerDraft('s1', 'Investigate this')
    expect(seen).toEqual(['s1'])
    expect(takeComposerDraft('s2')).toBeUndefined()
    expect(takeComposerDraft('s1')).toBe('Investigate this')
    expect(takeComposerDraft('s1')).toBeUndefined()
    off()
  })
})
