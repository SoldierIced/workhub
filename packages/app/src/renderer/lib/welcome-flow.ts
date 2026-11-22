/**
 * The welcome window's guided first run, as pure rules: which steps show for a goal, when a step
 * is complete, how each agent card reads the setup check, the default folder and the workspace's
 * name. The window (screens/SetupWindows.tsx) only draws them.
 */
import { goalIncludesCode, missingInstallers, slugId, type InstallerId, type Profile, type SetupFix, type SetupGoal, type SetupItem, type SignInTool } from '@workhub/core'
import { folderName } from './home'

export type WelcomeStep = 'goal' | 'agent' | 'signIn' | 'folder' | 'code' | 'ready'

/** The steps, in order, for a goal. Connecting code and tickets only shows for the code goals. */
export function welcomeSteps(goal: SetupGoal | null): WelcomeStep[] {
  return ['goal', 'agent', 'signIn', 'folder', ...(goal && goalIncludesCode(goal) ? (['code'] as const) : []), 'ready']
}

export function nextStep(steps: readonly WelcomeStep[], current: WelcomeStep): WelcomeStep {
  const i = steps.indexOf(current)
  return steps[Math.min(i + 1, steps.length - 1)] ?? current
}

export function previousStep(steps: readonly WelcomeStep[], current: WelcomeStep): WelcomeStep {
  const i = steps.indexOf(current)
  return steps[Math.max(i - 1, 0)] ?? current
}

/** The agents the welcome offers, Claude first: it comes with Workhub and needs nothing installed. */
export const WELCOME_AGENTS = ['claude', 'codex', 'kiro', 'opencode', 'gemini'] as const
export type WelcomeAgent = (typeof WELCOME_AGENTS)[number]

export const isWelcomeAgent = (value: unknown): value is WelcomeAgent => typeof value === 'string' && (WELCOME_AGENTS as readonly string[]).includes(value)

/** What the check found for an agent. `unknown`: the check did not answer (a timeout). */
export type AgentReadiness = 'ready' | 'signedOut' | 'notInstalled' | 'unknown'

/** The tool each agent signs in with inside Workhub; null: it signs in on its first session. */
export function agentSignInTool(agent: WelcomeAgent): SignInTool | null {
  return agent === 'claude' || agent === 'codex' || agent === 'kiro' ? agent : null
}

/** The rows that tell an agent's state: installed (Claude Code's row), then signed in (the first Claude login). */
function agentRows(agent: WelcomeAgent, items: readonly SetupItem[]): { install?: SetupItem; signIn?: SetupItem } {
  if (agent === 'claude') return { install: items.find((i) => i.kind === 'claudeCode'), signIn: items.find((i) => i.kind === 'claudeSignIn') }
  const row = items.find((i) => i.kind === agent)
  return { install: row, signIn: row }
}

/** How an agent's card reads the setup check; null while the check has not answered yet. */
export function agentReadiness(agent: WelcomeAgent, items: readonly SetupItem[]): AgentReadiness | null {
  const { install, signIn } = agentRows(agent, items)
  if (!install) return null
  if (install !== signIn && install.status === 'missing') return 'notInstalled'
  const row = signIn ?? install
  if (row.status === 'ok') return 'ready'
  if (row.fix?.kind === 'signIn') return 'signedOut'
  // A missing row with no sign-in to offer is a missing command (Claude's login row says "install first").
  return row.status === 'missing' ? 'notInstalled' : 'unknown'
}

/** The fix the card offers: the install one when the agent is not installed. */
export function agentInstallFix(agent: WelcomeAgent, items: readonly SetupItem[]): SetupFix | undefined {
  const { install } = agentRows(agent, items)
  return install && install.status !== 'ok' && install.fix?.kind !== 'signIn' ? install.fix : undefined
}

/** The in-app sign-in of the agent's row (with the Claude account it is for), when signed out. */
export function agentSignInFix(agent: WelcomeAgent, items: readonly SetupItem[]): Extract<SetupFix, { kind: 'signIn' }> | null {
  const { signIn } = agentRows(agent, items)
  return signIn?.status !== 'ok' && signIn?.fix?.kind === 'signIn' ? signIn.fix : null
}

/** Where the folder step starts: Documents for talking about files, the home folder for code. */
export function defaultFolder(goal: SetupGoal | null, folders: { home: string; documents: string }): string {
  return goal === 'files' ? folders.documents || folders.home : folders.home
}

/** The workspace's name: the one typed, else the folder's own name, so it is never empty for a real folder. */
export function workspaceName(typed: string, folder: string): string {
  return typed.trim() || (folder.trim() ? folderName(folder.trim()) : '')
}

/** The workspace that already holds this folder, when the welcome runs again. */
export function workspaceOf(profiles: readonly Pick<Profile, 'id' | 'folders'>[], folder: string): string | null {
  return profiles.find((p) => (p.folders ?? []).includes(folder))?.id ?? null
}

/** A new workspace (profile) for one folder, with the chosen agent first, and an id no other one has. */
export function newWorkspace(name: string, folder: string, agent: WelcomeAgent | null, existingIds: readonly string[]): Profile {
  const base = slugId(name, 'profile')
  let id = base
  for (let n = 2; existingIds.includes(id); n++) id = `${base}-${n}`
  return {
    id,
    name,
    connections: {},
    accountIds: [],
    modules: { flows: false, health: false, chatWatcher: false, automations: false, flowMaps: false, planner: false, boards: false },
    folders: [folder],
    ...(agent ? { preferredAgents: [agent] } : {})
  }
}

export interface WelcomeState {
  goal: SetupGoal | null
  agent: WelcomeAgent | null
  folder: string
  name: string
  /** The latest setup check. */
  items: readonly SetupItem[]
}

const rowOk = (items: readonly SetupItem[], kind: SetupItem['kind']) => items.some((i) => i.kind === kind && i.status === 'ok')

/** Whether a step has what it asks for (Next is offered); the sign-in and code steps can be skipped instead. */
export function stepComplete(step: WelcomeStep, state: WelcomeState): boolean {
  switch (step) {
    case 'goal':
      return state.goal !== null
    case 'agent': {
      if (!state.agent) return false
      const r = agentReadiness(state.agent, state.items)
      return r !== null && r !== 'notInstalled'
    }
    case 'signIn':
      return state.agent !== null && agentReadiness(state.agent, state.items) === 'ready'
    case 'folder':
      return state.folder.trim() !== '' && workspaceName(state.name, state.folder) !== ''
    case 'code':
      return rowOk(state.items, 'git')
    case 'ready':
      return true
  }
}

/** Steps a person may leave without finishing them. */
export const canSkip = (step: WelcomeStep): boolean => step === 'signIn' || step === 'code'

export type SummaryLine = 'goal' | 'agent' | 'signIn' | 'folder' | 'git' | 'codeHost' | 'tracker'

/** The Ready step's list: what is set and what is still missing, in the order of the steps. */
export function readySummary(state: WelcomeState): { line: SummaryLine; done: boolean }[] {
  const lines: { line: SummaryLine; done: boolean }[] = [
    { line: 'goal', done: stepComplete('goal', state) },
    { line: 'agent', done: stepComplete('agent', state) },
    { line: 'signIn', done: stepComplete('signIn', state) },
    { line: 'folder', done: stepComplete('folder', state) }
  ]
  if (state.goal && goalIncludesCode(state.goal)) {
    lines.push(
      { line: 'git', done: rowOk(state.items, 'git') },
      { line: 'codeHost', done: rowOk(state.items, 'github') || rowOk(state.items, 'gitlab') },
      { line: 'tracker', done: rowOk(state.items, 'linear') || rowOk(state.items, 'jira') }
    )
  }
  return lines
}

/** A session can start once there is an agent that is installed and a folder. */
export const canStartSession = (state: WelcomeState): boolean => stepComplete('agent', state) && stepComplete('folder', state)

/**
 * What "Install what is missing" installs on a welcome step: the chosen agent on the agent step
 * (and git, for the code goals), git and the needed code host tools on the code step. Only what
 * Workhub can install here (an Install fix); the main process adds Node.js first when needed.
 */
export function welcomeInstallers(step: WelcomeStep, state: Pick<WelcomeState, 'goal' | 'agent' | 'items'>): InstallerId[] {
  const code = state.goal !== null && goalIncludesCode(state.goal)
  const git = code ? missingInstallers(state.items.filter((i) => i.kind === 'git').map((i) => ({ ...i, optional: false }))) : []
  if (step === 'agent') {
    const fix = state.agent ? agentInstallFix(state.agent, state.items) : undefined
    return [...(fix?.kind === 'install' ? [fix.installer] : []), ...git]
  }
  if (step === 'code') return [...git, ...missingInstallers(state.items.filter((i) => i.kind === 'github' || i.kind === 'gitlab'))]
  return []
}
