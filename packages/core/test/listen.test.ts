import { describe, expect, it } from 'vitest'
import {
  appOptions,
  DEFAULT_LISTEN_MODEL,
  fallbackSpeech,
  LISTEN_DIRECT_MAX,
  LISTEN_FALLBACK_MAX,
  LISTEN_SYSTEM_PROMPT,
  listenPlan,
  listenPrompt,
  needsSummary,
  parseConfig,
  spokenSummary,
  truncateForSummary
} from '@workhub/core'

const long = (n: number) => Array.from({ length: n }, (_, i) => `Sentence number ${i} about the acme checkout.`).join(' ')

describe('listenPlan', () => {
  it('reads a short message directly, cleaned of Markdown, with no model', () => {
    expect(listenPlan('**Done.** See [the PR](https://example.com/pr/1) and `npm test`.')).toEqual({ kind: 'direct', text: 'Done. See the PR and npm test.' })
    expect(needsSummary('Short answer.')).toBe(false)
  })

  it('summarizes once the speakable text reaches the threshold, and when only code is left', () => {
    const text = 'a'.repeat(LISTEN_DIRECT_MAX - 1)
    expect(listenPlan(text).kind).toBe('direct')
    expect(listenPlan(text + 'a').kind).toBe('summarize')
    expect(needsSummary(long(20))).toBe(true)
    // A long code block alone has nothing speakable: the model says what it is about.
    expect(listenPlan('```ts\nconst x = 1\n```')).toEqual({ kind: 'summarize' })
    // The threshold counts speakable text: a short sentence with a big code block is read directly.
    expect(listenPlan(`Here is the fix.\n\n\`\`\`ts\n${'x\n'.repeat(500)}\`\`\``)).toEqual({ kind: 'direct', text: 'Here is the fix.' })
  })

  it('has nothing to read in an empty message', () => {
    expect(listenPlan('  \n ')).toEqual({ kind: 'empty' })
  })
})

describe('truncateForSummary and listenPrompt', () => {
  it('keeps a message under the cap whole, with no note', () => {
    expect(truncateForSummary('hello', 10)).toEqual({ text: 'hello', cut: 0 })
    const prompt = listenPrompt('hello', 10)
    expect(prompt).toContain('<message>\nhello\n</message>')
    expect(prompt).not.toContain('cut here')
  })

  it('cuts at a line break or space near the cap and says how much was left out', () => {
    const text = `${'word '.repeat(30)}\n${'tail '.repeat(30)}`
    const { text: kept, cut } = truncateForSummary(text, 100)
    expect(kept.length).toBeLessThanOrEqual(100)
    expect(kept.endsWith('word')).toBe(true)
    expect(cut).toBe(text.length - kept.length)
    const prompt = listenPrompt(text, 100)
    expect(prompt).toContain(`${cut} more characters were left out`)
    expect(prompt.indexOf('cut here')).toBeLessThan(prompt.indexOf('</message>'))
  })

  it('cuts hard when there is no break near the cap, never inside an emoji', () => {
    expect(truncateForSummary('x'.repeat(50), 20)).toEqual({ text: 'x'.repeat(20), cut: 30 })
    const emoji = `${'x'.repeat(19)}😀${'y'.repeat(10)}`
    expect(truncateForSummary(emoji, 20).text).toBe('x'.repeat(19))
  })

  it('asks for short spoken prose in the message language', () => {
    expect(LISTEN_SYSTEM_PROMPT).toMatch(/same language/)
    expect(LISTEN_SYSTEM_PROMPT).toMatch(/two to six/)
    expect(LISTEN_SYSTEM_PROMPT).toMatch(/no URLs/)
  })
})

describe('spoken text', () => {
  it('cleans Markdown the model still wrote, and caps the fallback', () => {
    expect(spokenSummary('**The build** passed. See https://example.com.')).toBe('The build passed. See.')
    expect(fallbackSpeech(long(200)).length).toBeLessThanOrEqual(LISTEN_FALLBACK_MAX)
  })
})

describe('listenModel option', () => {
  it('defaults to haiku and keeps a model alias or id', () => {
    expect(DEFAULT_LISTEN_MODEL).toBe('haiku')
    expect(appOptions(parseConfig({ version: 8 })).listenModel).toBe('haiku')
    expect(appOptions(parseConfig({ version: 8, options: { listenModel: ' claude-sonnet-4-5 ' } })).listenModel).toBe('claude-sonnet-4-5')
    expect(() => parseConfig({ version: 8, options: { listenModel: 'haiku; rm -rf' } })).toThrow()
  })
})
