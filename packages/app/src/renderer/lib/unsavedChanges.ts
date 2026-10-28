/**
 * Unsaved changes in forms that need an explicit save (Settings → Profiles, Accounts, Connections,
 * Trackers, Health, Slack, the automation editor): dirty tracking and the "save, discard or stay"
 * guard in front of anything that would throw a draft away. Pure state, no React: the hooks and the
 * save bar read it through `subscribe` and `snapshot`.
 */

/** JSON-like text of a draft with sorted keys; `undefined` values and missing keys read the same. */
export function draftKey(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      )
    }
    return v
  }) ?? 'undefined'
}

/** True when the draft differs from what was loaded (or last saved). */
export function isDirty(baseline: unknown, current: unknown): boolean {
  return draftKey(baseline) !== draftKey(current)
}

/**
 * True when a profile's environment rows differ from the loaded ones: a typed value (values are
 * never loaded back, so any text is new), or a name added, renamed or removed.
 */
export function envDirty(rows: readonly { name: string; value: string }[], loaded: readonly { name: string }[]): boolean {
  return rows.some((r) => r.value !== '') || rows.length !== loaded.length || rows.some((r, i) => r.name !== loaded[i]?.name)
}

/** What a form's save did: on failure, `problem` says what to fix (the bar shows it instead of saving). */
export type SaveOutcome = { ok: true } | { ok: false; problem?: string }

/** A form with a draft, as the guard sees it. */
export interface UnsavedForm {
  dirty: boolean
  save: () => Promise<SaveOutcome>
  discard: () => void
}

export interface UnsavedSnapshot {
  /** Some registered form has unsaved changes. */
  dirty: boolean
  saving: boolean
  /** The last save failed: `problem` is what to fix, or null when only the server's issues say it. */
  failed: boolean
  problem: string | null
  /** The server's last refusal in words, shown when a failed save gave no `problem` of its own. */
  serverProblem: string | null
  /** When the last save went through (for the brief "Saved" confirmation). */
  savedAt: number | null
  /** A leave (close, tab, other item) waits for the user's choice. */
  prompting: boolean
}

export interface UnsavedChanges {
  /** Adds or replaces a form under `id`; returns the function that removes it. */
  register: (id: string, form: UnsavedForm) => () => void
  /** The draft changed after a refused save: the old problem no longer applies. */
  clearFailure: () => void
  /** Records the server's last refusal (null after a success). */
  reportProblem: (text: string | null) => void
  /** Reads the forms' `dirty` again (a form calls it when its draft changes). */
  refresh: () => void
  snapshot: () => UnsavedSnapshot
  subscribe: (listener: () => void) => () => void
  /** Saves every dirty form in registration order; stops at the first failure. */
  saveAll: () => Promise<boolean>
  /** Throws every draft away. */
  discardAll: () => void
  /** Runs `leave` now when nothing is dirty, else keeps it until the user answers the prompt. */
  requestLeave: (leave: () => void) => void
  /** The prompt's answers. */
  answer: (choice: 'save' | 'discard' | 'cancel') => Promise<void>
}

export function createUnsavedChanges(now: () => number = Date.now): UnsavedChanges {
  const forms = new Map<string, UnsavedForm>()
  const listeners = new Set<() => void>()
  let pending: (() => void) | null = null
  let state: UnsavedSnapshot = { dirty: false, saving: false, failed: false, problem: null, serverProblem: null, savedAt: null, prompting: false }

  const dirtyForms = () => [...forms.values()].filter((f) => f.dirty)
  const set = (patch: Partial<UnsavedSnapshot>) => {
    const next = { ...state, ...patch, dirty: dirtyForms().length > 0 }
    // A form that is no longer dirty has nothing left to fix.
    if (!next.dirty && !next.saving) {
      next.failed = false
      next.problem = null
    }
    if (Object.keys(next).every((k) => next[k as keyof UnsavedSnapshot] === state[k as keyof UnsavedSnapshot])) return
    state = next
    for (const l of listeners) l()
  }

  const saveAll = async () => {
    if (state.saving) return false
    set({ saving: true, failed: false, problem: null, serverProblem: null })
    for (const form of dirtyForms()) {
      let outcome: SaveOutcome
      try {
        outcome = await form.save()
      } catch (e) {
        outcome = { ok: false, problem: e instanceof Error ? e.message : String(e) }
      }
      if (!outcome.ok) {
        set({ saving: false, failed: true, problem: outcome.problem ?? null })
        return false
      }
    }
    set({ saving: false, failed: false, problem: null, savedAt: now() })
    return true
  }

  return {
    register(id, form) {
      forms.set(id, form)
      set({})
      return () => {
        if (forms.get(id) === form) forms.delete(id)
        set({})
      }
    },
    refresh: () => set({}),
    clearFailure: () => {
      if (state.failed && !state.saving) set({ failed: false, problem: null })
    },
    reportProblem: (text) => set({ serverProblem: text }),
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    saveAll,
    discardAll() {
      for (const form of dirtyForms()) form.discard()
      set({ failed: false, problem: null })
    },
    requestLeave(leave) {
      if (dirtyForms().length === 0) return leave()
      pending = leave
      set({ prompting: true })
    },
    async answer(choice) {
      const leave = pending
      if (choice === 'cancel') {
        pending = null
        return set({ prompting: false })
      }
      if (choice === 'discard') {
        for (const form of dirtyForms()) form.discard()
        pending = null
        set({ prompting: false, failed: false, problem: null })
        return leave?.()
      }
      // Save: a failure closes the prompt and leaves the user on the form, with the bar saying why.
      set({ prompting: false })
      pending = null
      if (await saveAll()) leave?.()
    }
  }
}
