import type { AgentAccount } from '@workhub/core'
import type { AgentOptionsView, SessionView } from '@shared/api'

export interface PickerOption {
  value: string
  label: string
  description?: string
}

export interface PickerState {
  visible: boolean
  options: PickerOption[]
  /** The option on screen; `''` is "the agent's default" where `allowDefault`. */
  value: string
  disabled: boolean
  /** Whether "the agent's default" can be picked again (native Claude; ACP cannot ask for it). */
  allowDefault: boolean
}

const HIDDEN: PickerState = { visible: false, options: [], value: '', disabled: true, allowDefault: false }

/** The model picker of a session header: shown while the chat runs and the agent lists models it can switch to. */
export function sessionModelPicker(v: SessionView): PickerState {
  const models = v.models ?? []
  if (v.mode !== 'app' || !(v.modelControl ?? v.controls) || models.length === 0) return HIDDEN
  const allowDefault = v.adapter !== 'acp'
  const offered = v.currentModelId && models.some((m) => m.id === v.currentModelId) ? v.currentModelId : ''
  const options = models.map((m) => ({ value: m.id, label: m.name, ...(m.description ? { description: m.description } : {}) }))
  // An ACP session always runs some model: when it is not in the list, show it as reported.
  if (!allowDefault && !offered && v.currentModelId) options.unshift({ value: v.currentModelId, label: v.currentModelId })
  return { visible: true, options, value: offered || (allowDefault ? '' : (v.currentModelId ?? options[0]?.value ?? '')), disabled: v.state !== 'ready', allowDefault }
}

/**
 * The mode picker of a session header: the agent (Kiro, OpenCode), or the permission / approval
 * preset (Codex, Gemini, Claude over ACP). Hidden for a review session, which keeps its read-only mode.
 */
export function sessionModePicker(v: SessionView): PickerState & { kind: 'agent' | 'permission' } {
  const modes = v.availableModes ?? []
  const kind = v.permissionMode?.id === 'agent-managed' ? 'agent' : 'permission'
  if (v.mode !== 'app' || !v.modeControl || v.readOnly || modes.length < 2) return { ...HIDDEN, kind }
  return {
    visible: true,
    kind,
    options: modes.map((m) => ({ value: m.id, label: m.name, ...(m.description ? { description: m.description } : {}) })),
    value: v.currentModeId && modes.some((m) => m.id === v.currentModeId) ? v.currentModeId : '',
    disabled: v.state !== 'ready',
    allowDefault: false
  }
}

/**
 * What a new session starts with. Model: the last pick for this agent key, else the account's
 * default. Mode: the defaults set in Settings → Agents win (the account's, then the agent's), so a
 * default permission mode applies to every new session; with none set, the last pick. Else the
 * agent's own default (`''`). A candidate the agent no longer lists is dropped; with no list known
 * yet it is kept (the agent ignores an unknown one).
 */
export function initialStartChoice(
  kind: 'model' | 'mode',
  options: Pick<AgentOptionsView, 'models' | 'modes'> | null,
  remembered: string | undefined,
  account: Pick<AgentAccount, 'defaultModel' | 'defaultMode'> | null,
  agentDefaultMode?: string
): string {
  const list = (kind === 'model' ? options?.models : options?.modes) ?? []
  const candidates = kind === 'model' ? [remembered, account?.defaultModel] : [account?.defaultMode, agentDefaultMode, remembered]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (!list.length || list.some((o) => o.id === candidate)) return candidate
  }
  return ''
}
