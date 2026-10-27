/**
 * The sessions open when the app quit, reopened at the next launch (Workhub 1's
 * `Workbench.persistSessions` / `restoreSessions`). Each one is stored with what starting it again
 * needs: its agent and account, profile, folder, mode and stable identity. Reopening resumes the
 * agent's own conversation when it still exists (else the same session id starts fresh in the
 * same folder); nothing is ever prompted again. The sidebar order and groups live in the config
 * (keyed by identity), so restored sessions land at their old places.
 */
import { effectiveAgentKey, type SessionGroups } from '@workhub/core'
import type { SessionMode, SessionView, StartSessionInput } from '../shared/api'

export interface SavedOpenSession {
  /** `sessionIdentity` of the session: sidebar groups, names and session windows key it by this. */
  identity: string
  /** `effectiveAgentKey(agentId, accountId)`. */
  agentKey: string
  profileId: string | null
  cwd: string
  /** What the session showed: the chat, the agent's console or the shell. */
  mode: SessionMode
  /** The engine under the shell (the shell runs beside the chat or the console). */
  engine: 'app' | 'console'
  /** The agent's own session id, resumed when its conversation still exists. */
  agentSessionId?: string
  model?: string
}

export interface SavedOpenSessions {
  sessions: SavedOpenSession[]
}

export interface OpenSessionsStore {
  load(fallback: SavedOpenSessions): SavedOpenSessions
  save(value: SavedOpenSessions): void
  flush(): void
}

export interface OpenSessionsDeps {
  store: OpenSessionsStore
  /** The open sessions, in the order they were opened. */
  list(): SessionView[]
  /** The engine a session runs (the shell shows over one of them). */
  engineOf(id: string): 'app' | 'console' | undefined
  /** Starts a stored session again (`SessionManager.start` with `restored`: it resumes only a conversation that still exists). */
  start(input: StartSessionInput): Promise<SessionView>
  setMode(id: string, mode: SessionMode): Promise<void>
  /** Whether the session's folder is still there. */
  folderExists(path: string): Promise<boolean>
  /** Settings → General → "Reopen sessions on launch". */
  enabled(): Promise<boolean>
  /** The sidebar layout, for the order sessions are reopened in. */
  groups(): Promise<SessionGroups | undefined>
  log?: (message: string, err?: unknown) => void
}

const MODES: readonly SessionMode[] = ['app', 'console', 'shell']

/** What is stored for an open session; null for one that is not reopened (an AI reviewer). */
export function savedSessionOf(view: SessionView, engine: 'app' | 'console' | undefined): SavedOpenSession | null {
  if (view.readOnly || !view.agentId) return null
  const identity = view.agentSessionId ?? view.identity ?? view.id
  return {
    identity,
    agentKey: effectiveAgentKey(view.agentId, view.accountId ?? null),
    profileId: view.profileId ?? null,
    cwd: view.cwd,
    mode: view.mode,
    engine: engine ?? (view.mode === 'console' ? 'console' : 'app'),
    ...(view.agentSessionId ? { agentSessionId: view.agentSessionId } : {}),
    ...(view.currentModelId ? { model: view.currentModelId } : {})
  }
}

/** Parses the stored file; malformed entries are left out. */
export function readSavedSessions(raw: unknown): SavedOpenSession[] {
  const list = raw && typeof raw === 'object' ? (raw as { sessions?: unknown }).sessions : undefined
  if (!Array.isArray(list)) return []
  const out: SavedOpenSession[] = []
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    const identity = str(r['identity'])
    const agentKey = str(r['agentKey'])
    const cwd = str(r['cwd'])
    if (!identity || !agentKey || !cwd || out.some((s) => s.identity === identity)) continue
    const mode = MODES.includes(r['mode'] as SessionMode) ? (r['mode'] as SessionMode) : 'app'
    const engine = r['engine'] === 'console' ? 'console' : r['engine'] === 'app' ? 'app' : mode === 'console' ? 'console' : 'app'
    const agentSessionId = str(r['agentSessionId'])
    const model = str(r['model'])
    out.push({
      identity,
      agentKey,
      profileId: str(r['profileId']) ?? null,
      cwd,
      mode,
      engine,
      ...(agentSessionId ? { agentSessionId } : {}),
      ...(model ? { model } : {})
    })
  }
  return out
}

/** The sessions in sidebar order (top level, a group's members in place); the rest keep their stored order, after them. */
export function restoreOrder(saved: readonly SavedOpenSession[], groups: SessionGroups | undefined): SavedOpenSession[] {
  if (!groups) return [...saved]
  const order: string[] = []
  for (const slot of groups.top) {
    if (slot.kind === 'session') order.push(slot.key)
    else order.push(...(groups.groups.find((g) => g.id === slot.id)?.members.map((m) => m.key) ?? []))
  }
  const rank = (s: SavedOpenSession) => {
    const i = order.indexOf(s.identity)
    return i < 0 ? order.length : i
  }
  return saved.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map(({ s }) => s)
}

export class OpenSessions {
  /** Nothing is saved before the stored sessions are reopened (the empty list would replace them) or once the app quits. */
  private ready = false
  private frozen = false
  private restoring: Promise<void> | null = null

  constructor(private readonly deps: OpenSessionsDeps) {}

  /** The open sessions changed: the stored list follows. */
  changed(): void {
    if (!this.ready || this.frozen) return
    this.deps.store.save({ sessions: this.current() })
  }

  /** The app is quitting: the list stays as it is now while the sessions stop. */
  freeze(): void {
    if (this.frozen) return
    if (this.ready) this.deps.store.save({ sessions: this.current() })
    this.frozen = true
    this.deps.store.flush()
  }

  /**
   * Reopens the sessions stored at the last quit, once (the main window is listening by then, so
   * a resumed chat's earlier conversation reaches it). Each one starts in the background; a
   * session whose folder or agent is gone is skipped.
   */
  restore(): Promise<void> {
    this.restoring ??= this.run().finally(() => {
      this.ready = true
      this.changed()
    })
    return this.restoring
  }

  private current(): SavedOpenSession[] {
    const out: SavedOpenSession[] = []
    for (const v of this.deps.list()) {
      const s = savedSessionOf(v, this.deps.engineOf(v.id))
      if (s && !out.some((o) => o.identity === s.identity)) out.push(s)
    }
    return out
  }

  private async run(): Promise<void> {
    const saved = readSavedSessions(this.deps.store.load({ sessions: [] }))
    if (!saved.length || !(await this.deps.enabled())) return
    const open = new Set(this.current().map((s) => s.identity))
    for (const s of restoreOrder(saved, await this.deps.groups())) {
      if (open.has(s.identity) || this.frozen) continue
      try {
        if (!(await this.deps.folderExists(s.cwd))) continue
        const view = await this.deps.start({
          profileId: s.profileId,
          agentKey: s.agentKey,
          cwd: s.cwd,
          mode: s.engine,
          ...(s.agentSessionId ? { resumeAgentSessionId: s.agentSessionId } : { identity: s.identity }),
          ...(s.model ? { model: s.model } : {})
        })
        if (s.mode === 'shell') await this.deps.setMode(view.id, 'shell').catch((err: unknown) => this.deps.log?.('could not reopen the shell of a restored session', err))
      } catch (err) {
        this.deps.log?.(`could not reopen session ${s.identity}`, err)
      }
    }
  }
}
