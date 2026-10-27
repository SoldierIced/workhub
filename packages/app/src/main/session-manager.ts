import { randomUUID } from 'node:crypto'
import {
  isTerminalControl,
  launchEnvironment,
  resolveEffectiveAgents,
  sessionScreens,
  type AgentAdapterKind,
  type AgentEvent,
  type AgentRuntime,
  type ConfigurationService
} from '@workhub/core'
import type { SessionView, StartSessionInput } from '../shared/api'

/**
 * Owns every session of the app: picks the runtime by adapter kind, keeps the session state
 * the renderer shows, and forwards runtime events.
 */
export class SessionManager {
  private readonly sessions = new Map<string, { view: SessionView; runtime: AgentRuntime }>()

  constructor(
    private readonly config: ConfigurationService,
    private readonly runtimes: Partial<Record<AgentAdapterKind, AgentRuntime>>,
    private readonly emitEvent: (e: AgentEvent) => void,
    private readonly emitChanged: (s: SessionView) => void
  ) {
    for (const runtime of Object.values(runtimes)) runtime.subscribe((e) => this.onEvent(e))
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => s.view)
  }

  async start(input: StartSessionInput): Promise<SessionView> {
    const config = await this.config.current()
    const choice = resolveEffectiveAgents(config, input.profileId).find((e) => e.key === input.agentKey)
    if (!choice) throw new Error(`agent "${input.agentKey}" is not offered by this profile`)
    const runtime = this.runtimes[choice.agent.adapter]
    if (!runtime) throw new Error(`no runtime for adapter "${choice.agent.adapter}" yet (native adapters arrive in P2)`)

    const capabilities = runtime.capabilities(choice.agent)
    const view: SessionView = {
      id: randomUUID(),
      agentId: choice.agent.id,
      accountId: choice.account?.id ?? null,
      profileId: input.profileId,
      cwd: input.cwd,
      state: 'starting',
      permissionMode: null,
      startedAt: Date.now(),
      label: choice.label,
      agentName: choice.agent.name,
      adapter: choice.agent.adapter,
      capabilities,
      screens: sessionScreens(capabilities)
    }
    this.sessions.set(view.id, { view, runtime })
    this.emitChanged(view)

    // session/new can take 10-15 s: answer now, report progress through `changed` events.
    void runtime
      .start({
        sessionId: view.id,
        agent: choice.agent,
        account: choice.account,
        cwd: input.cwd,
        env: launchEnvironment(choice.agent, choice.account),
        cols: input.cols,
        rows: input.rows
      })
      .then((started) =>
        this.update(view.id, {
          agentSessionId: started.agentSessionId,
          agentName: started.agentName,
          permissionMode: started.permissionMode,
          currentModeId: started.currentModeId,
          availableModes: started.availableModes
        })
      )
      .catch((err: unknown) => this.update(view.id, { state: 'error', error: err instanceof Error ? err.message : String(err) }))
    return view
  }

  async prompt(id: string, text: string): Promise<string> {
    return (await this.require(id).runtime.prompt(id, text)).stopReason
  }

  async cancel(id: string): Promise<void> {
    await this.require(id).runtime.cancel(id)
  }

  async stop(id: string): Promise<void> {
    await this.require(id).runtime.stop(id)
    this.update(id, { state: 'stopped' })
  }

  respondPermission(id: string, requestId: string, optionId: string | null): void {
    this.sessions.get(id)?.runtime.respondPermission(id, requestId, optionId)
  }

  write(id: string, data: string): void {
    const rt = this.sessions.get(id)?.runtime
    if (rt && isTerminalControl(rt)) rt.write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    const rt = this.sessions.get(id)?.runtime
    if (rt && isTerminalControl(rt)) rt.resize(id, cols, rows)
  }

  async stopAll(): Promise<void> {
    await Promise.all(Object.values(this.runtimes).map((r) => r.stopAll()))
  }

  private onEvent(e: AgentEvent): void {
    if (e.type === 'state') this.update(e.sessionId, { state: e.state, ...(e.error ? { error: e.error } : {}) })
    if (e.type === 'permissionMode') this.update(e.sessionId, { permissionMode: e.mode, currentModeId: e.currentModeId })
    this.emitEvent(e)
  }

  private update(id: string, patch: Partial<SessionView>): void {
    const s = this.sessions.get(id)
    if (!s) return
    // A finished session keeps its final state even if a late event arrives.
    if ((s.view.state === 'stopped' || s.view.state === 'error') && patch.state && patch.state !== s.view.state) {
      if (patch.state !== 'stopped' && patch.state !== 'error') return
    }
    s.view = { ...s.view, ...patch }
    this.emitChanged(s.view)
  }

  private require(id: string): { view: SessionView; runtime: AgentRuntime } {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session ${id}`)
    return s
  }
}
