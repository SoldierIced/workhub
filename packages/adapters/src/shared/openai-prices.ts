/**
 * OpenAI list prices in USD per million tokens, for Codex sessions billed by API key. Bundled (no
 * network): update this table when prices change or new models ship. A model missing from it is
 * reported as unpriced tokens, never guessed. Last reviewed: 2026-10-27, from the published API
 * price list known at that date; models newer than that (e.g. `gpt-5.5`) are not in it yet.
 *
 * `cached` is the cached-input price. Matching is on the whole model id, with an optional date
 * suffix (`-2025-08-07`), so `gpt-5` never prices `gpt-5.5`.
 */
export interface OpenAiPrice {
  input: number
  cached: number
  output: number
}

const TABLE: readonly [string, OpenAiPrice][] = [
  ['gpt-5.2', { input: 1.75, cached: 0.175, output: 14 }],
  ['gpt-5.2-codex', { input: 1.75, cached: 0.175, output: 14 }],
  ['gpt-5.1', { input: 1.25, cached: 0.125, output: 10 }],
  ['gpt-5.1-codex', { input: 1.25, cached: 0.125, output: 10 }],
  ['gpt-5.1-codex-max', { input: 1.25, cached: 0.125, output: 10 }],
  ['gpt-5.1-codex-mini', { input: 0.25, cached: 0.025, output: 2 }],
  ['gpt-5', { input: 1.25, cached: 0.125, output: 10 }],
  ['gpt-5-codex', { input: 1.25, cached: 0.125, output: 10 }],
  ['gpt-5-mini', { input: 0.25, cached: 0.025, output: 2 }],
  ['gpt-5-nano', { input: 0.05, cached: 0.005, output: 0.4 }],
  ['codex-mini-latest', { input: 1.5, cached: 0.375, output: 6 }],
  ['gpt-4.1', { input: 2, cached: 0.5, output: 8 }],
  ['gpt-4.1-mini', { input: 0.4, cached: 0.1, output: 1.6 }],
  ['o3', { input: 2, cached: 0.5, output: 8 }],
  ['o4-mini', { input: 1.1, cached: 0.275, output: 4.4 }]
]
const PRICES = new Map(TABLE)

/** The price of a model id (`gpt-5-codex`, `openai/gpt-5.1-2025-11-13`); undefined when unknown. */
export function openAiPrice(model: string | undefined): OpenAiPrice | undefined {
  if (!model) return undefined
  const id = model
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
  return PRICES.get(id)
}

/** USD for fresh (non-cached) input, cached input and output tokens; undefined for an unknown model. */
export function openAiCost(model: string | undefined, tokens: { input: number; cached: number; output: number }): number | undefined {
  const p = openAiPrice(model)
  if (!p) return undefined
  return (tokens.input * p.input + tokens.cached * p.cached + tokens.output * p.output) / 1_000_000
}
