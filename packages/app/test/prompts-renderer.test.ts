import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HEALTH_THRESHOLDS, fenceUntrusted, parseFlowMap, placeholdersIn, promptDefinition, PROMPT_IDS, type FlowMap, type PromptId, type PullRequestDetail, type SlowTransaction, type TrendStats } from '@workhub/core'
import type { PullRequestTarget, TicketTarget } from '../src/shared/links-api'
import { en } from '../src/renderer/i18n/en'
import { es } from '../src/renderer/i18n/es'
import { interpolate, translate, type MessageKey } from '../src/renderer/i18n/translate'
import { eventPrompt, errorsPrompt, flowPrompt, silentPrompt, togetherPrompt } from '../src/renderer/lib/healthPrompts'
import { reviewPrompt, ticketPrompt } from '../src/renderer/lib/links'
import { feedbackPrompt } from '../src/renderer/lib/prFeedback'
import { flowMapPrompt } from '../src/renderer/screens/flowMaps/flowMapPrompt'

const RENDERER_IDS = PROMPT_IDS.filter((id) => ['links', 'health'].includes(promptDefinition(id).area) && promptDefinition(id).i18nKey)

const pr: PullRequestTarget = { provider: 'github', owner: 'acme', repo: 'shop', number: 7, url: 'https://github.com/acme/shop/pull/7', title: 'Retry webhooks', branch: 'feat/retry', base: 'main', author: 'ana' }
const ticket: TicketTarget = { key: 'DEMO-1', title: 'Add retries', url: 'https://tickets.example.com/DEMO-1' } as TicketTarget
const detail: Pick<PullRequestDetail, 'checks' | 'reviews' | 'threads'> = {
  checks: [{ name: 'unit tests', status: 'failure', url: 'https://ci.example.com/2' }],
  reviews: [{ id: 'r1', author: 'bob', isBot: false, state: 'changesRequested', body: 'Please add a test.' }],
  threads: []
}
const stats: TrendStats = { recent: 10, typicalDay: 2, streakDays: 1, streakTruncated: false, daysWithData: 3, state: 'new' }
const penv = { name: 'Production', thresholds: DEFAULT_HEALTH_THRESHOLDS }
const tx: SlowTransaction = { service: 'api', name: 'GET /x', calls: 10, p50Ms: 1, p95Ms: 2, p99Ms: 3, failureRate: 0 }

describe('renderer prompt definitions', () => {
  it('default to the interface text, with the same placeholders in both languages', () => {
    expect(RENDERER_IDS.length).toBe(9)
    for (const id of RENDERER_IDS) {
      const def = promptDefinition(id)
      const key = def.i18nKey as MessageKey
      expect(def.defaultText, id).toBe(en[key])
      for (const dict of [en, es]) {
        const used = placeholdersIn(dict[key])
        expect(used.filter((p) => !def.placeholders.includes(p)), id).toEqual([])
        for (const slot of def.slots ?? []) expect(used, id).toContain(slot)
      }
    }
  })
})

describe('links prompts', () => {
  const own = { 'links.reviewPr': 'Look at {name} ({title}) by {author}.', 'links.ticket': 'Do {key} {url}', 'links.ticketNoUrl': 'Do {key} without link' }
  it('uses the default text with no override, in both languages', () => {
    expect(reviewPrompt('en', pr)).toBe(translate('en', 'links.prompt.review', { name: 'shop#7', title: pr.title, url: pr.url, branch: pr.branch, base: pr.base, author: pr.author }))
    expect(reviewPrompt('es', pr)).toContain('Revisa el pull request')
    expect(ticketPrompt('en', ticket)).toContain('Ticket link: https://tickets.example.com/DEMO-1')
  })
  it('uses the override with its placeholders filled', () => {
    expect(reviewPrompt('en', pr, own)).toMatch(/^Look at shop#7 \(Retry webhooks\) by ana\.$/)
    expect(ticketPrompt('es', ticket, own)).toBe('Do DEMO-1 https://tickets.example.com/DEMO-1')
    expect(ticketPrompt('en', { ...ticket, url: undefined }, own)).toBe('Do DEMO-1 without link')
  })
})

describe('pull request feedback prompts', () => {
  const fenced = fenceUntrusted('Title: Retry webhooks\nFailing checks:\n- unit tests: https://ci.example.com/2', 20_000)
  it('puts the untrusted note right before the data, byte-identical to the default text', () => {
    for (const locale of ['en', 'es'] as const) {
      const text = feedbackPrompt(locale, 'fixCi', pr, detail)
      expect(text).toContain(`\n\n${translate(locale, 'prFeedback.note.fixCi')}\n${fenced}\n\n`)
      expect(text.startsWith(translate(locale, 'prFeedback.prompt.fixCi').split('{data}')[0]!.replaceAll('{name}', 'shop#7').replaceAll('{url}', pr.url).replaceAll('{branch}', pr.branch))).toBe(true)
    }
  })
  it('keeps the note and the data when the text is rewritten', () => {
    const text = feedbackPrompt('en', 'addressReview', pr, detail, { 'links.addressReview': 'Handle {name}.\n{data}\nThanks.' })
    expect(text.startsWith('Handle shop#7.\n')).toBe(true)
    expect(text).toContain(translate('en', 'prFeedback.note.addressReview'))
    expect(text).toContain('Please add a test.')
    expect(text.endsWith('\nThanks.')).toBe(true)
    expect(feedbackPrompt('en', 'fixCi', pr, detail, { 'links.fixCi': 'Fix it:\n{data}' })).toContain(translate('en', 'prFeedback.note.fixCi'))
  })
})

describe('health prompts', () => {
  const err = { service: 'api', stats }
  it('end with the closing request, or the user text', () => {
    expect(errorsPrompt('en', err, {}, penv, null).endsWith(translate('en', 'healthPrompt.ask'))).toBe(true)
    const o = { 'health.ask': 'Just look.', 'health.flowAsk': 'Look at the endpoint.', 'health.togetherAsk': 'Look at all.' }
    expect(errorsPrompt('en', err, {}, penv, null, true, o).endsWith('Just look.')).toBe(true)
    expect(errorsPrompt('en', err, {}, penv, 'https://kibana.example', true, o)).toContain('Kibana: https://kibana.example')
    expect(silentPrompt('en', { service: 's', lastSeen: 0, silentMinutes: 5, isReporting: false }, undefined, penv, null, true, o).endsWith(` Just look.`)).toBe(true)
    expect(eventPrompt('en', { reason: 'Failed', stats } as never, penv, true, o).endsWith('\nJust look.')).toBe(true)
    expect(flowPrompt('en', tx, {}, penv, null, true, o).endsWith('Look at the endpoint.')).toBe(true)
    expect(flowPrompt('en', tx, {}, penv, null, true).endsWith(translate('en', 'healthPrompt.flow.ask'))).toBe(true)
  })
  it('asks once at the end of the combined draft', () => {
    const s = { errors: [err], silent: [], pods: [], events: [], flows: [] }
    const c = { env: penv, profileName: 'Work', errors: {}, pods: {}, flows: {}, errorServices: [err], links: { errors: {}, pods: {}, services: {} } }
    expect(togetherPrompt('en', s, c).endsWith(translate('en', 'healthPrompt.together.ask'))).toBe(true)
    const text = togetherPrompt('en', s, { ...c, overrides: { 'health.togetherAsk': 'Look at all.', 'health.ask': 'NO' } })
    expect(text.endsWith('\nLook at all.')).toBe(true)
    expect(text).toContain('## 1. api · errors')
    expect(text).not.toContain('NO')
  })
})

describe('flow map prompt', () => {
  const map = (parseFlowMap(JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'docs', 'examples', 'flow-maps', 'checkout.json'), 'utf8'))) as { ok: true; map: FlowMap }).map
  const t = (key: string, params?: Record<string, string | number>) => interpolate((en as Record<string, string>)[key] ?? key, params)
  it('ends with the request, or the user text', () => {
    const base = { map, file: 'x.json', environment: 'Production', locale: 'en' }
    expect(flowMapPrompt(t as never, base).endsWith(en['flowMapPrompt.ask'])).toBe(true)
    const own = flowMapPrompt(t as never, { ...base, overrides: { 'health.flowMapAsk': 'Explain.' } })
    expect(own.endsWith('\n\nExplain.')).toBe(true)
    expect(own).toContain('# Flow map "Checkout" on Production')
  })
})

// Keeps the compiler honest: the ids used above exist.
const _ids: PromptId[] = ['links.reviewPr', 'links.ticket', 'links.ticketNoUrl', 'links.fixCi', 'links.addressReview', 'health.ask', 'health.flowAsk', 'health.togetherAsk', 'health.flowMapAsk']
void _ids
