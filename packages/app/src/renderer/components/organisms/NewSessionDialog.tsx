import { AgentIcon } from '../atoms/AgentIcon'
import { FolderOpen, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { pickAgent, type EffectiveAgent, type Profile } from '@workhub/core'
import { newSessionProfile } from '../../lib/folders'
import { useI18n } from '../../i18n/I18nProvider'
import { installHintKey } from '../../lib/agents'
import type { AgentOptionsView, WorkspaceFolder } from '@shared/api'
import { initialStartChoice } from '../../lib/agent-pickers'
import { readPrefs, rememberMode, rememberModel } from '../../lib/prefs'
import { Button } from '../atoms/Button'
import { IconButton } from '../atoms/IconButton'
import { Input } from '../atoms/Input'
import { Select } from '../atoms/Select'
import { Dialog } from '../molecules/Dialog'
import { Field } from '../molecules/Field'
import { errorText } from '../../lib/errorText'
import { currentConfig } from '../../configStore'

export interface NewSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profileId: string | null
  agents: EffectiveAgent[]
  /** The profile's agent order; its first agent is preselected. */
  preferredAgents?: string[]
  initialAgentKey?: string
  initialCwd?: string
  /** Every profile: a folder another profile owns starts the session in that profile, with its agents. */
  profiles?: readonly Profile[]
  /** The profile's folders and the folders inside them (the sidebar's list), offered as the folder is typed. */
  folders?: readonly WorkspaceFolder[]
  onStarted: (sessionId: string) => void
}

/** "Default (auto)": the default option names the agent's own default when it is known. */
const optionDefault = (label: string, id: string | undefined) => (id ? `${label} (${id})` : label)

/** Starts a session with the active profile: pick the agent, the folder, and the model and agent or mode where the agent has them. */
export function NewSessionDialog({ open, onOpenChange, profileId, agents: activeAgents, preferredAgents: activePreferred, initialAgentKey, initialCwd, profiles = [], folders = [], onStarted }: NewSessionDialogProps) {
  const { t } = useI18n()
  const [agentKey, setAgentKey] = useState('')
  const [cwd, setCwd] = useState('')
  // As in Workhub 1, the session belongs to the profile that owns its folder: the agents and
  // accounts offered follow it.
  const [home, setHome] = useState<string | undefined>()
  useEffect(() => {
    if (open) void window.hub.getDefaultCwd().then(setHome, () => setHome(undefined))
  }, [open])
  const sessionProfileId = useMemo(() => newSessionProfile(cwd, profileId, profiles, home), [cwd, profileId, profiles, home])
  const owner = profiles.find((p) => p.id === sessionProfileId)
  const [ownerAgents, setOwnerAgents] = useState<EffectiveAgent[] | null>(null)
  useEffect(() => {
    setOwnerAgents(null)
    if (!open || sessionProfileId === profileId) return
    let alive = true
    void window.hub.config.effectiveAgents(sessionProfileId).then(
      (list) => alive && setOwnerAgents(list),
      () => alive && setOwnerAgents(null)
    )
    return () => {
      alive = false
    }
  }, [open, sessionProfileId, profileId])
  const otherProfile = sessionProfileId !== profileId && ownerAgents !== null
  const agents = otherProfile ? ownerAgents : activeAgents
  const preferredAgents = otherProfile ? owner?.preferredAgents : activePreferred
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Agent id -> installed; an agent missing from the answer is treated as installed.
  const [installed, setInstalled] = useState<Record<string, boolean>>({})
  // What the chosen agent offers (models, agents or modes) and the picks for this session.
  const [options, setOptions] = useState<AgentOptionsView | null>(null)
  const [loadingOptions, setLoadingOptions] = useState(false)
  const [model, setModel] = useState('')
  const [modeId, setModeId] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setAgentKey((k) =>
      initialAgentKey && activeAgents.some((a) => a.key === initialAgentKey)
        ? initialAgentKey
        : activeAgents.some((a) => a.key === k)
          ? k
          : (pickAgent({ preferredAgents: activePreferred }, activeAgents, 'any')?.key ?? '')
    )
    if (initialCwd) setCwd(initialCwd)
    else void window.hub.getDefaultCwd().then((d) => setCwd((c) => c || d))
  }, [open, initialAgentKey, initialCwd, activeAgents, activePreferred])

  // Another profile's agents: keep the pick when that profile offers it too, else its first choice.
  useEffect(() => {
    if (!open) return
    setAgentKey((k) => (agents.some((a) => a.key === k) ? k : (pickAgent({ preferredAgents }, agents, 'any')?.key ?? '')))
  }, [open, agents, preferredAgents])

  useEffect(() => {
    if (open) void window.hub.agents.availability().then(setInstalled, () => setInstalled({}))
  }, [open])

  const chosen = agents.find((a) => a.key === agentKey)
  const missing = chosen !== undefined && installed[chosen.agent.id] === false
  // Only agents that run over ACP or natively take a model or mode at start.
  const configurable = chosen !== undefined && chosen.agent.adapter !== 'terminal' && chosen.agent.capabilities.appMode

  const agentKeyRef = useRef(agentKey)
  agentKeyRef.current = agentKey
  const loadOptions = (refresh: boolean) => {
    if (!chosen || !configurable) {
      setOptions(null)
      return
    }
    const key = chosen.key
    setLoadingOptions(true)
    void window.hub.agents
      .options(key, refresh)
      .then(
        (o) => {
          if (key !== agentKeyRef.current) return
          setOptions(o)
          const prefs = readPrefs()
          setModel(initialStartChoice('model', o, prefs.models[key], chosen.account))
          setModeId(initialStartChoice('mode', o, prefs.modes[key], chosen.account, currentConfig()?.config.options?.agentDefaultModes?.[chosen.agent.id]))
        },
        () => setOptions(null)
      )
      .finally(() => setLoadingOptions(false))
  }
  useEffect(() => {
    if (!open) return
    setOptions(null)
    setModel('')
    setModeId('')
    loadOptions(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agentKey, configurable])

  const start = async () => {
    setError('')
    setBusy(true)
    try {
      // Nothing picked: the main process falls back to the account's defaults, then the agent's.
      const view = await window.hub.sessions.start({ profileId: sessionProfileId, agentKey, cwd, cols: 100, rows: 30, ...(model ? { model } : {}), ...(modeId ? { modeId } : {}) })
      if (configurable) {
        rememberModel(agentKey, model || null)
        rememberMode(agentKey, modeId || null)
      }
      onOpenChange(false)
      onStarted(view.id)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('newSession.title')}
      description={t('newSession.description')}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!agentKey || !cwd || busy || missing} onClick={() => void start()}>
            {t('newSession.start')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (agentKey && cwd && !busy && !missing) void start()
        }}
      >
        <Field
          label={t('newSession.agent')}
          hint={
            agents.length === 0 ? (
              t('session.noAgents')
            ) : missing ? (
              <span className="text-warning" data-testid="agent-install-hint">
                {t(installHintKey(chosen.agent.id), { command: chosen.agent.command })}
              </span>
            ) : undefined
          }
        >
          <Select
            value={agentKey}
            onChange={setAgentKey}
            options={agents.map((a) => ({ value: a.key, icon: <AgentIcon agentId={a.agent.id} adapter={a.agent.adapter} />, label: installed[a.agent.id] === false ? `${a.label} (${t('newSession.notInstalled')})` : a.label }))}
            placeholder={t('session.noAgents')}
          />
        </Field>
        {configurable && (options?.models.length || options?.modes.length || loadingOptions || options?.source === 'none') ? (
          <div className="grid grid-cols-2 gap-3" data-testid="new-session-options">
            {(options?.modes.length ?? 0) > 0 && (
              <Field label={t(options?.modeSemantics === 'persona' ? 'newSession.mode' : 'newSession.permissionMode')}>
                <Select
                  aria-label={t(options?.modeSemantics === 'persona' ? 'newSession.mode' : 'newSession.permissionMode')}
                  value={modeId}
                  onChange={setModeId}
                  options={[
                    { value: '', label: optionDefault(t('agentControls.agentDefault'), options?.defaultModeId) },
                    ...(options?.modes ?? []).map((m) => ({ value: m.id, label: m.name }))
                  ]}
                />
              </Field>
            )}
            {(options?.models.length ?? 0) > 0 && (
              <Field label={t('newSession.model')}>
                <Select
                  aria-label={t('newSession.model')}
                  value={model}
                  onChange={setModel}
                  options={[{ value: '', label: optionDefault(t('session.modelDefault'), options?.defaultModelId) }, ...(options?.models ?? []).map((m) => ({ value: m.id, label: m.name }))]}
                />
              </Field>
            )}
            <p className="col-span-2 flex items-center gap-2 text-xs text-subtle">
              <span className="flex-1">
                {loadingOptions
                  ? t('newSession.loadingOptions')
                  : options?.source === 'cli'
                    ? t('newSession.optionsFromCli')
                    : options?.source === 'session'
                      ? t('newSession.optionsFromSession')
                      : t('newSession.noOptions')}
              </span>
              <IconButton size="sm" className="size-6" label={t('newSession.refreshOptions')} icon={<RefreshCw className="size-3" />} disabled={loadingOptions} onClick={() => loadOptions(true)} />
            </p>
          </div>
        ) : null}
        <Field label={t('newSession.folder')}>
          <div className="flex gap-2">
            <Input aria-label={t('newSession.folder')} value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} list={folders.length ? 'new-session-folders' : undefined} />
            {folders.length > 0 && (
              <datalist id="new-session-folders">
                {folders.map((f) => (
                  <option key={f.path} value={f.path} label={f.name} />
                ))}
              </datalist>
            )}
            <IconButton
              label={t('newSession.browse')}
              icon={<FolderOpen className="size-4" />}
              className="border border-border bg-surface"
              onClick={() => void window.hub.pickFolder().then((d) => d && setCwd(d))}
            />
          </div>
        </Field>
        {otherProfile && owner && <p className="-mt-2 text-xs text-subtle">{t('newSession.otherProfile', { name: owner.name })}</p>}
        {error && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
