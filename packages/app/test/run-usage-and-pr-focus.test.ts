import { describe, expect, it } from 'vitest'
import { runUsageLabel } from '../src/renderer/lib/runUsage'
import { registerCodeHostIpc, type CodeHostService } from '../src/main/codehost'
import type { IpcRegistrar } from '../src/main/ipc-guard'

const format = { money: (c: { amount: number; currency: string }) => `${c.currency} ${c.amount.toFixed(2)}`, tokens: (n: number) => `${n} tokens` }

describe('run log usage', () => {
  it('shows the cost, else the tokens, else nothing', () => {
    expect(runUsageLabel({ cost: { amount: 0.456, currency: 'USD' }, tokens: 10 }, format)).toBe('USD 0.46')
    expect(runUsageLabel({ cost: { amount: 0, currency: 'USD' }, tokens: 1200 }, format)).toBe('1200 tokens')
    expect(runUsageLabel({ tokens: 1200 }, format)).toBe('1200 tokens')
    expect(runUsageLabel({ cost: { amount: 0, currency: 'USD' } }, format)).toBe('USD 0.00')
    expect(runUsageLabel({}, format)).toBeNull()
  })
})

describe('"Show in Workhub" from a PR window', () => {
  function setup(recognized: boolean) {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const ipc: IpcRegistrar = { handle: (c, l) => void handlers.set(c, l), on: () => undefined }
    const shown: [string, string | null][] = []
    const service = { recognizes: async () => recognized } as unknown as CodeHostService
    registerCodeHostIpc(ipc, { service, openWindow: () => undefined, showInWorkhub: (url, profileId) => void shown.push([url, profileId]), openExternal: async () => undefined })
    return { call: () => handlers.get('codeHost:showInWorkhub')!({}, 'work', 'https://github.com/acme/web/pull/7'), shown }
  }

  it('asks the main window to show a recognized PR', async () => {
    const { call, shown } = setup(true)
    await call()
    expect(shown).toEqual([['https://github.com/acme/web/pull/7', 'work']])
  })

  it('ignores a URL no connected host recognizes', async () => {
    const { call, shown } = setup(false)
    await call()
    expect(shown).toEqual([])
  })
})
