/**
 * OpenAI list prices in USD per million tokens (Standard tier, text), for Codex sessions billed by
 * API key. Bundled (no network): update this table when prices change or models ship. A model
 * missing from it is reported as unpriced tokens, never guessed.
 *
 * Verified 2026-10-27 against OpenAI's official pricing page,
 * https://developers.openai.com/api/docs/pricing (platform.openai.com/docs/pricing redirects there),
 * and, for models shut down since (still in older rollouts), their model pages under
 * https://developers.openai.com/api/docs/models/<id>. gpt-5.6-sol's price is promotional, "available
 * at least through November 21, 2026"; the page gives no regular price yet.
 *
 * `long` is the price for a request over 272K input tokens (the page's long-context tier, applied
 * to the whole request). A `-pro` model has no cached-input price: cached tokens bill as input.
 * Not modelled: cache-write prices ("30m/12h write") of the newest models, Batch/Flex/Fast tiers
 * and regional processing uplifts; the figure is an estimate at Standard list prices.
 *
 * Matching is on the whole model id, with an optional date suffix (`-2025-08-07`) or provider
 * prefix (`openai/`), so `gpt-5` never prices `gpt-5.5`.
 */
export interface OpenAiPrice {
  input: number
  cached: number
  output: number
  /** Over 272K input tokens in one request. */
  long?: { input: number; cached: number; output: number }
}

/** Input tokens of one request above which the long-context price applies. */
export const OPENAI_LONG_CONTEXT = 272_000

const p = (input: number, cached: number, output: number, long?: [number, number, number]): OpenAiPrice => ({
  input,
  cached,
  output,
  ...(long ? { long: { input: long[0], cached: long[1], output: long[2] } } : {})
})

const TABLE: readonly [string, OpenAiPrice][] = [
  // Current (pricing page).
  ['gpt-6-astra', p(10, 1, 50, [20, 2, 75])],
  ['gpt-6.1-sol', p(2, 0.1, 10, [4, 0.2, 15])],
  ['gpt-6.1-terra', p(1, 0.05, 5, [2, 0.1, 7.5])],
  ['gpt-6-luna', p(0.1, 0.01, 0.5, [0.2, 0.02, 0.75])],
  ['gpt-5.6-sol', p(4, 0.4, 20, [8, 0.8, 30])],
  ['gpt-5.6-terra', p(2, 0.2, 12, [4, 0.4, 18])],
  ['gpt-5.6-luna', p(0.2, 0.02, 1.2, [0.4, 0.04, 1.8])],
  ['gpt-5.6-cyber', p(12.5, 1.25, 75)],
  ['gpt-5.5', p(5, 0.5, 30, [10, 1, 45])],
  ['gpt-5.5-pro', p(30, 30, 180, [60, 60, 270])],
  ['gpt-5.5-cyber', p(12.5, 1.25, 75)],
  ['gpt-5.4', p(2.5, 0.25, 15, [5, 0.5, 22.5])],
  ['gpt-5.4-pro', p(30, 30, 180, [60, 60, 270])],
  ['gpt-5.4-mini', p(0.75, 0.075, 4.5)],
  ['gpt-5.4-nano', p(0.2, 0.02, 1.25)],
  ['gpt-5.3-codex', p(1.75, 0.175, 14)],
  ['gpt-5.2', p(1.75, 0.175, 14)],
  ['gpt-5.2-pro', p(21, 21, 168)],
  ['gpt-5.1', p(1.25, 0.125, 10)],
  ['gpt-5', p(1.25, 0.125, 10)],
  ['gpt-5-mini', p(0.25, 0.025, 2)],
  ['gpt-5-nano', p(0.05, 0.005, 0.4)],
  ['gpt-5-pro', p(15, 15, 120)],
  ['gpt-4.1', p(2, 0.5, 8)],
  ['gpt-4.1-mini', p(0.4, 0.1, 1.6)],
  ['gpt-4.1-nano', p(0.1, 0.025, 0.4)],
  ['gpt-4o-mini', p(0.15, 0.075, 0.6)],
  ['o3', p(2, 0.5, 8)],
  ['o4-mini', p(1.1, 0.275, 4.4)],
  // Shut down (model pages), kept for older rollouts.
  ['gpt-5.2-codex', p(1.75, 0.175, 14)],
  ['gpt-5.1-codex', p(1.25, 0.125, 10)],
  ['gpt-5.1-codex-max', p(1.25, 0.125, 10)],
  ['gpt-5.1-codex-mini', p(0.25, 0.025, 2)],
  ['gpt-5-codex', p(1.25, 0.125, 10)],
  ['codex-mini-latest', p(1.5, 0.375, 6)]
]
const PRICES = new Map(TABLE)

/** The price of a model id (`gpt-5.5`, `openai/gpt-5.1-2025-11-13`); undefined when unknown. */
export function openAiPrice(model: string | undefined): OpenAiPrice | undefined {
  if (!model) return undefined
  const id = model
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
  return PRICES.get(id)
}

/**
 * USD for fresh (non-cached) input, cached input and output tokens; undefined for an unknown model.
 * `requestInput` (the input tokens of the one request these tokens belong to) picks the
 * long-context price when it is over 272K.
 */
export function openAiCost(model: string | undefined, tokens: { input: number; cached: number; output: number }, requestInput?: number): number | undefined {
  const base = openAiPrice(model)
  if (!base) return undefined
  const price = base.long && requestInput !== undefined && requestInput > OPENAI_LONG_CONTEXT ? base.long : base
  return (tokens.input * price.input + tokens.cached * price.cached + tokens.output * price.output) / 1_000_000
}
