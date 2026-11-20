import { beforeEach, describe, expect, it, vi } from 'vitest'

// A minimal stand-in for React's hooks, enough to run the hook by hand: state and refs keep their slot
// between renders, and an effect runs again only when its dependencies changed.
type Slot = { value?: unknown; deps?: unknown[]; cleanup?: unknown }
let slots: Slot[] = []
let cursor = 0
let pending: (() => void)[] = []
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (init: unknown) => {
    const i = cursor++
    slots[i] ??= { value: typeof init === 'function' ? (init as () => unknown)() : init }
    const slot = slots[i]!
    return [slot.value, (next: unknown) => void (slot.value = typeof next === 'function' ? (next as (p: unknown) => unknown)(slot.value) : next)]
  },
  useRef: (init: unknown) => (slots[cursor] ??= { value: { current: init } }, slots[cursor++]!.value),
  useCallback: (fn: unknown) => (cursor++, fn),
  useMemo: (fn: () => unknown) => (cursor++, fn()),
  useEffect: (fn: () => unknown, deps: unknown[]) => {
    const slot = (slots[cursor++] ??= {})
    if (slot.deps && deps.length === slot.deps.length && deps.every((d, i) => Object.is(d, slot.deps![i]))) return
    slot.deps = deps
    pending.push(() => {
      if (typeof slot.cleanup === 'function') slot.cleanup()
      slot.cleanup = fn()
    })
  }
}))
vi.mock('../src/web/app-context', () => ({ useClient: () => ({}), useRemoteData: () => ({}) }))

const { useMilestoneOpenTickets } = await import('../src/web/plan-data')

const useRendered = (...args: Parameters<typeof useMilestoneOpenTickets>) => {
  cursor = 0
  useMilestoneOpenTickets(...args)
  const run = pending
  pending = []
  run.forEach((f) => f())
  // The re-render React does after the effect set state.
  cursor = 0
  return useMilestoneOpenTickets(...args)
}
const flush = () => new Promise((r) => setTimeout(r, 0))
const open = (total: number) => ({ tickets: [], total, unassigned: 0, stale: 0, addedLate: 0 })

describe('useMilestoneOpenTickets', () => {
  const openTickets = vi.fn()
  beforeEach(() => {
    slots = []
    pending = []
    openTickets.mockReset()
    vi.stubGlobal('window', { hub: { planner: { openTickets } } })
  })

  it('asks again when the planner view changes, and keeps the list on screen meanwhile', async () => {
    openTickets.mockResolvedValueOnce(open(3)).mockResolvedValueOnce(open(2))
    const view1 = { milestones: [] }
    useRendered('p', 'm1', view1)
    await flush()
    expect(openTickets).toHaveBeenCalledTimes(1)
    expect(useRendered('p', 'm1', view1).ask).toEqual({ state: 'done', open: open(3) })
    expect(openTickets).toHaveBeenCalledTimes(1)

    const view2 = { milestones: [] }
    expect(useRendered('p', 'm1', view2).ask).toEqual({ state: 'done', open: open(3) })
    expect(openTickets).toHaveBeenCalledTimes(2)
    await flush()
    expect(useRendered('p', 'm1', view2).ask).toEqual({ state: 'done', open: open(2) })
    expect(openTickets).toHaveBeenCalledTimes(2)
  })

  it('starts from loading for another milestone, and when the answer is unknown it says null, not none', async () => {
    openTickets.mockResolvedValueOnce(open(3)).mockResolvedValueOnce(null)
    const view = {}
    useRendered('p', 'm1', view)
    await flush()
    expect(useRendered('p', 'm1', view).ask.state).toBe('done')
    expect(useRendered('p', 'm2', view).ask).toEqual({ state: 'loading' })
    await flush()
    expect(useRendered('p', 'm2', view).ask).toEqual({ state: 'done', open: null })
  })
})
