import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RefreshButton } from '../src/renderer/components/molecules/RefreshButton'
import { TooltipProvider } from '../src/renderer/components/atoms'
import { createRefreshGuard } from '../src/renderer/lib/refreshGuard'

const html = (props: Partial<Parameters<typeof RefreshButton>[0]>) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(RefreshButton, { label: 'Refresh', ...props })))

describe('RefreshButton markup', () => {
  it('is idle by default: no spin, enabled, not busy', () => {
    const out = html({})
    expect(out).not.toContain('animate-spin')
    expect(out).not.toContain('disabled=""')
    expect(out).toContain('aria-busy="false"')
  })

  it.each(['icon', 'button'] as const)('spins, is disabled and aria-busy while loading (%s variant)', (variant) => {
    const out = html({ loading: true, variant })
    expect(out).toContain('animate-spin')
    expect(out).toContain('motion-reduce:animate-pulse')
    expect(out).toContain('disabled=""')
    expect(out).toContain('aria-busy="true"')
  })

  it('keeps a caller-disabled button disabled when idle', () => {
    expect(html({ disabled: true })).toContain('disabled=""')
  })
})

describe('createRefreshGuard', () => {
  const deferred = () => {
    let resolve!: () => void
    let reject!: (e: Error) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('is busy while the promise is pending and ignores a second click', async () => {
    const d = deferred()
    let calls = 0
    const states: boolean[] = []
    const click = createRefreshGuard(() => (calls++, d.promise), (b) => states.push(b))
    const first = click()
    await click()
    expect(calls).toBe(1)
    expect(states).toEqual([true])
    d.resolve()
    await first
    expect(states).toEqual([true, false])
  })

  it('re-enables after the promise resolves', async () => {
    let calls = 0
    const states: boolean[] = []
    const click = createRefreshGuard(async () => void calls++, (b) => states.push(b))
    await click()
    await click()
    expect(calls).toBe(2)
    expect(states).toEqual([true, false, true, false])
  })

  it('re-enables after the promise rejects, without throwing', async () => {
    const d = deferred()
    const states: boolean[] = []
    const click = createRefreshGuard(() => d.promise, (b) => states.push(b))
    const run = click()
    d.reject(new Error('boom'))
    await expect(run).resolves.toBeUndefined()
    expect(states).toEqual([true, false])
    const again = createRefreshGuard(() => Promise.reject(new Error('x')), (b) => states.push(b))
    await again()
    expect(states.at(-1)).toBe(false)
  })

  it('treats a handler that returns nothing as finished at once', async () => {
    const states: boolean[] = []
    await createRefreshGuard(() => undefined, (b) => states.push(b))()
    expect(states).toEqual([true, false])
  })
})
