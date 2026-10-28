import { describe, expect, it, vi } from 'vitest'
import { createUnsavedChanges, draftKey, envDirty, isDirty, type SaveOutcome, type UnsavedForm } from '../src/renderer/lib/unsavedChanges'

/** A form whose draft the test edits by hand. */
function fakeForm(outcome: SaveOutcome = { ok: true }) {
  const form = {
    dirty: false,
    saves: 0,
    discards: 0,
    save: async () => {
      form.saves++
      if (outcome.ok) form.dirty = false
      return outcome
    },
    discard: () => {
      form.discards++
      form.dirty = false
    }
  }
  return form satisfies UnsavedForm & { saves: number; discards: number }
}

describe('dirty tracking', () => {
  it('ignores key order and undefined fields', () => {
    expect(draftKey({ a: 1, b: { c: 2, d: undefined } })).toBe(draftKey({ b: { c: 2 }, a: 1 }))
    expect(isDirty({ id: 'x', folders: undefined }, { id: 'x' })).toBe(false)
  })

  it('sees edited values, array order and nested changes', () => {
    expect(isDirty({ name: 'Acme' }, { name: 'Acme!' })).toBe(true)
    expect(isDirty({ ids: ['a', 'b'] }, { ids: ['b', 'a'] })).toBe(true)
    expect(isDirty({ modules: { health: false } }, { modules: { health: true } })).toBe(true)
  })

  it('treats a typed environment value or an added, renamed or removed name as a change', () => {
    const loaded = [{ name: 'TOKEN', value: '', stored: true }]
    expect(envDirty(loaded, loaded)).toBe(false)
    expect(envDirty([{ name: 'TOKEN', value: 'x' }], loaded)).toBe(true)
    expect(envDirty([...loaded, { name: '', value: '' }], loaded)).toBe(true)
    expect(envDirty([{ name: 'OTHER', value: '' }], loaded)).toBe(true)
    expect(envDirty([], loaded)).toBe(true)
  })
})

describe('unsaved changes store', () => {
  it('is dirty while a registered form is, and forgets a form that unmounts', () => {
    const store = createUnsavedChanges()
    const form = fakeForm()
    const unregister = store.register('a', form)
    expect(store.snapshot().dirty).toBe(false)
    form.dirty = true
    store.refresh()
    expect(store.snapshot().dirty).toBe(true)
    unregister()
    expect(store.snapshot().dirty).toBe(false)
  })

  it('notifies subscribers only when the snapshot changes', () => {
    const store = createUnsavedChanges()
    const listener = vi.fn()
    store.subscribe(listener)
    const form = fakeForm()
    store.register('a', form)
    store.refresh()
    expect(listener).not.toHaveBeenCalled()
    form.dirty = true
    store.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('saves every dirty form and records when', async () => {
    const store = createUnsavedChanges(() => 42)
    const a = fakeForm()
    const b = fakeForm()
    const clean = fakeForm()
    store.register('a', a)
    store.register('b', b)
    store.register('clean', clean)
    a.dirty = b.dirty = true
    expect(await store.saveAll()).toBe(true)
    expect([a.saves, b.saves, clean.saves]).toEqual([1, 1, 0])
    expect(store.snapshot()).toMatchObject({ dirty: false, saving: false, failed: false, savedAt: 42 })
  })

  it('stops at a refused save and says what to fix', async () => {
    const store = createUnsavedChanges()
    const bad = fakeForm({ ok: false, problem: 'Name is required' })
    const after = fakeForm()
    store.register('bad', bad)
    store.register('after', after)
    bad.dirty = after.dirty = true
    expect(await store.saveAll()).toBe(false)
    expect(after.saves).toBe(0)
    expect(store.snapshot()).toMatchObject({ dirty: true, failed: true, problem: 'Name is required', savedAt: null })
  })

  it("falls back to the server's refusal when the form gives no problem", async () => {
    const store = createUnsavedChanges()
    const form = fakeForm({ ok: false })
    store.register('a', form)
    form.dirty = true
    const saving = store.saveAll()
    store.reportProblem('Id is taken')
    await saving
    expect(store.snapshot()).toMatchObject({ failed: true, problem: null, serverProblem: 'Id is taken' })
  })

  it('discard clears the drafts and the last problem', async () => {
    const store = createUnsavedChanges()
    const form = fakeForm({ ok: false, problem: 'x' })
    store.register('a', form)
    form.dirty = true
    await store.saveAll()
    store.discardAll()
    expect(form.discards).toBe(1)
    expect(store.snapshot()).toMatchObject({ dirty: false, failed: false, problem: null })
  })
})

describe('unsaved changes guard', () => {
  it('leaves at once when nothing is dirty', () => {
    const store = createUnsavedChanges()
    store.register('a', fakeForm())
    const leave = vi.fn()
    store.requestLeave(leave)
    expect(leave).toHaveBeenCalledOnce()
    expect(store.snapshot().prompting).toBe(false)
  })

  it('asks first when a form is dirty; Cancel stays', async () => {
    const store = createUnsavedChanges()
    const form = fakeForm()
    store.register('a', form)
    form.dirty = true
    const leave = vi.fn()
    store.requestLeave(leave)
    expect(leave).not.toHaveBeenCalled()
    expect(store.snapshot().prompting).toBe(true)
    await store.answer('cancel')
    expect(leave).not.toHaveBeenCalled()
    expect(store.snapshot()).toMatchObject({ prompting: false, dirty: true })
    expect(form.discards + form.saves).toBe(0)
  })

  it('Discard throws the draft away and leaves', async () => {
    const store = createUnsavedChanges()
    const form = fakeForm()
    store.register('a', form)
    form.dirty = true
    const leave = vi.fn()
    store.requestLeave(leave)
    await store.answer('discard')
    expect(form.discards).toBe(1)
    expect(leave).toHaveBeenCalledOnce()
  })

  it('Save saves, then leaves', async () => {
    const store = createUnsavedChanges()
    const form = fakeForm()
    store.register('a', form)
    form.dirty = true
    const leave = vi.fn()
    store.requestLeave(leave)
    await store.answer('save')
    expect(form.saves).toBe(1)
    expect(leave).toHaveBeenCalledOnce()
  })

  it('a refused Save keeps the user on the form with the problem shown', async () => {
    const store = createUnsavedChanges()
    const form = fakeForm({ ok: false, problem: 'Enter an id.' })
    store.register('a', form)
    form.dirty = true
    const leave = vi.fn()
    store.requestLeave(leave)
    await store.answer('save')
    expect(leave).not.toHaveBeenCalled()
    expect(store.snapshot()).toMatchObject({ prompting: false, dirty: true, failed: true, problem: 'Enter an id.' })
    // The refused leave is not replayed by a later save.
    form.dirty = true
    await store.saveAll()
    expect(leave).not.toHaveBeenCalled()
  })
})

describe('a refused save after an edit', () => {
  it('drops the old problem once the draft changes', async () => {
    const store = createUnsavedChanges()
    const form = fakeForm({ ok: false, problem: 'Name is required' })
    store.register('a', form)
    form.dirty = true
    await store.saveAll()
    store.clearFailure()
    expect(store.snapshot()).toMatchObject({ dirty: true, failed: false, problem: null })
  })
})
