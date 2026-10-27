import type { IpcMain } from 'electron'
import { detectPrEvents, EMPTY_PR_EVENT_STATE, type PrEventState, type PrEventStore, type PullRequest, type WorkhubConfig } from '@workhub/core'
import type { CodeHostLists } from '../shared/codehost-api'
import type { PrEventBatch, PrNotification } from '../shared/pr-events-api'

/** Workhub 1 synced every 180 seconds. */
export const PR_SYNC_MS = 180_000

/** The part of the code host service the sync reads through. */
export interface PrEventSource {
  lists(profileId: string | null, force: boolean): Promise<CodeHostLists>
  stateOf(profileId: string | null, url: string): Promise<PullRequest | null>
}

export interface PrEventServiceDeps {
  source: PrEventSource
  store: PrEventStore
  config: () => Promise<WorkhubConfig>
  /** Delivers a batch to the renderer; called only once the renderer is listening. */
  emit: (batch: PrEventBatch) => void
  /** Demo mode: only the active profile syncs, and `advance` moves the demo one step on. */
  demo?: { advance: () => number }
  now?: () => number
}

/**
 * Syncs the pull requests of each profile with a code host, compares them with the last sync and
 * hands the new events to the renderer (which words and shows the notification). The memory is
 * persisted per profile, so an event is handled once and an upgrade or a first run only seeds it.
 */
export class PrEventService {
  private state: PrEventState = { ...EMPTY_PR_EVENT_STATE, profiles: {} }
  private loaded = false
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | undefined
  private listening = false
  private buffered: PrEventBatch[] = []
  private readonly now: () => number

  constructor(private readonly deps: PrEventServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    void this.sync()
    this.timer = setInterval(() => void this.sync(), PR_SYNC_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** The renderer subscribed: deliver what was found before that. */
  rendererReady(): void {
    this.listening = true
    const pending = this.buffered
    this.buffered = []
    for (const batch of pending) this.deps.emit(batch)
  }

  private deliver(batch: PrEventBatch): void {
    if (this.listening) this.deps.emit(batch)
    else this.buffered.push(batch)
  }

  /** One sync of every profile with a code host; calls made while one runs share it. */
  sync(): Promise<void> {
    this.running ??= this.syncAll().finally(() => (this.running = undefined))
    return this.running
  }

  private async syncAll(): Promise<void> {
    if (!this.loaded) {
      this.state = await this.deps.store.load().catch(() => ({ ...EMPTY_PR_EVENT_STATE, profiles: {} }))
      this.loaded = true
    }
    const config = await this.deps.config()
    const profiles = config.profiles.filter((p) => (this.deps.demo ? p.id === config.activeProfileId : Boolean(p.connections.codeHost)))
    for (const profile of profiles) {
      try {
        await this.syncProfile(profile.id)
      } catch {
        // A failed sync keeps the memory as it was; the next one tries again.
      }
    }
  }

  private async syncProfile(profileId: string): Promise<void> {
    const lists = await this.deps.source.lists(profileId, true)
    // Not connected, signed out or a list that failed (its old figures would pass for fresh ones): keep the memory.
    if (lists.state !== 'ready' || lists.message) return
    const mine = lists.mine.map((i) => i.pr)
    const toReview = lists.toReview.map((i) => i.pr)
    const previous = this.state.profiles[profileId]
    const open = new Set(mine.map((p) => p.url))
    const left: Record<string, PullRequest> = {}
    for (const url of Object.keys(previous?.mine ?? {})) {
      if (open.has(url)) continue
      const pr = await this.deps.source.stateOf(profileId, url)
      if (pr) left[url] = pr
    }
    const result = detectPrEvents({ previous, mine, toReview, left, now: this.now() })
    this.state = { ...this.state, profiles: { ...this.state.profiles, [profileId]: result.state } }
    // Persist before announcing: a crash after the notification must not announce the same event again.
    await this.deps.store.save(this.state).catch(() => undefined)
    if (result.events.length) this.deliver({ profileId, events: result.events })
  }

  /** Demo mode: advance the demo and sync now. */
  async demoAdvance(): Promise<number | null> {
    if (!this.deps.demo) return null
    const step = this.deps.demo.advance()
    await this.sync()
    return step
  }
}

export interface PrEventsIpcDeps {
  service: PrEventService
  /** Shows an OS notification whose click opens the pull request. */
  notify: (n: PrNotification) => void
}

export function registerPrEventsIpc(ipc: IpcMain, { service, notify }: PrEventsIpcDeps): void {
  ipc.on('prEvents:ready', () => service.rendererReady())
  ipc.on('prEvents:notify', (_e, n: PrNotification) => {
    if (n && typeof n.title === 'string' && typeof n.url === 'string' && typeof n.profileId === 'string') notify(n)
  })
  ipc.handle('prEvents:demoAdvance', () => service.demoAdvance())
}

