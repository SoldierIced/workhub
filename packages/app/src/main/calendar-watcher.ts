import { dueActions, EMPTY_CALENDAR_STATE, pruneBriefs, pruneFired, type CalendarEvent, type CalendarState, type DueAction, type PlannerSettings } from '@workhub/core'
import type { StateFile } from './state-file'

/** How often the Plan watcher looks for reminders and briefs that are due. */
export const CALENDAR_WATCH_INTERVAL_MS = 30_000

/**
 * The Plan state shared by the watcher and the brief service (`calendar-state.json`): one copy in
 * memory, saved through the state file; old entries are pruned as it is written.
 */
export class CalendarStateStore {
  private state: CalendarState

  constructor(
    private readonly file: StateFile<CalendarState>,
    private readonly now: () => number = Date.now
  ) {
    const loaded = file.load(EMPTY_CALENDAR_STATE)
    this.state = { fired: { ...loaded.fired }, briefs: { ...loaded.briefs } }
  }

  get(): CalendarState {
    return this.state
  }

  update(change: (state: CalendarState) => CalendarState): CalendarState {
    const next = change(this.state)
    const now = this.now()
    this.state = { fired: pruneFired(next.fired, now), briefs: pruneBriefs(next.briefs, now) }
    this.file.save(this.state)
    return this.state
  }

  flush(): void {
    this.file.flush()
  }
}

export interface CalendarWatcherDeps {
  /** The profiles with the Plan module on. */
  profiles: () => Promise<{ id: string }[]>
  /** The profile's events (cached by the calendar service) and its Plan setup; null when it cannot be read. */
  read: (profileId: string) => Promise<{ events: CalendarEvent[]; settings: PlannerSettings } | null>
  store: CalendarStateStore
  remind: (profileId: string, action: DueAction) => void
  brief: (profileId: string, action: DueAction) => Promise<unknown>
  now?: () => number
  intervalMs?: number
  log?: (message: string) => void
}

/**
 * Looks every half minute for reminders and brief rules that are due in each profile with Plan
 * on. Each fires once per event instance and rule: the key is stored before acting, so a restart
 * or an overlapping tick never repeats it.
 */
export class CalendarWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private readonly deps: CalendarWatcherDeps) {}

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? CALENDAR_WATCH_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.deps.store.flush()
  }

  async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = (this.deps.now ?? Date.now)()
      for (const profile of await this.deps.profiles()) {
        const read = await this.deps.read(profile.id).catch(() => null)
        if (!read) continue
        const fired = this.deps.store.get().fired
        const due = dueActions(read.events, read.settings, now, (key) => `${profile.id}|${key}` in fired)
        if (!due.length) continue
        this.deps.store.update((s) => ({ ...s, fired: { ...s.fired, ...Object.fromEntries(due.map((d) => [`${profile.id}|${d.key}`, now])) } }))
        // Every due key is stored, but a meeting gets one reminder per look: two reminder rules that
        // come due together (overlapping leads, or the app was asleep past both) would repeat it.
        const reminded = new Set<string>()
        for (const action of due) {
          if (action.action === 'remind') {
            if (reminded.has(action.event.id)) continue
            reminded.add(action.event.id)
            this.deps.remind(profile.id, action)
          } else void this.deps.brief(profile.id, action).catch((error: unknown) => this.deps.log?.(`brief failed: ${error instanceof Error ? error.message : 'error'}`))
        }
      }
    } catch (error) {
      this.deps.log?.(`calendar watcher: ${error instanceof Error ? error.message : 'error'}`)
    } finally {
      this.running = false
    }
  }
}
