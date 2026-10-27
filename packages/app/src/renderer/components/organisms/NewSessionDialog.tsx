import { FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { pickAgent, type EffectiveAgent } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import { installHintKey } from '../../lib/agents'
import { readPrefs } from '../../lib/prefs'
import { Button } from '../atoms/Button'
import { IconButton } from '../atoms/IconButton'
import { Input } from '../atoms/Input'
import { Select } from '../atoms/Select'
import { Dialog } from '../molecules/Dialog'
import { Field } from '../molecules/Field'

export interface NewSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  profileId: string | null
  agents: EffectiveAgent[]
  /** The profile's agent order; its first agent is preselected. */
  preferredAgents?: string[]
  initialAgentKey?: string
  initialCwd?: string
  onStarted: (sessionId: string) => void
}

/** Starts a session with the active profile: pick the agent and the folder. */
export function NewSessionDialog({ open, onOpenChange, profileId, agents, preferredAgents, initialAgentKey, initialCwd, onStarted }: NewSessionDialogProps) {
  const { t } = useI18n()
  const [agentKey, setAgentKey] = useState('')
  const [cwd, setCwd] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Agent id -> installed; an agent missing from the answer is treated as installed.
  const [installed, setInstalled] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!open) return
    setError('')
    setAgentKey((k) =>
      initialAgentKey && agents.some((a) => a.key === initialAgentKey)
        ? initialAgentKey
        : agents.some((a) => a.key === k)
          ? k
          : (pickAgent({ preferredAgents }, agents, 'any')?.key ?? '')
    )
    if (initialCwd) setCwd(initialCwd)
    else void window.hub.getDefaultCwd().then((d) => setCwd((c) => c || d))
  }, [open, initialAgentKey, initialCwd, agents, preferredAgents])

  useEffect(() => {
    if (open) void window.hub.agents.availability().then(setInstalled, () => setInstalled({}))
  }, [open])

  const chosen = agents.find((a) => a.key === agentKey)
  const missing = chosen !== undefined && installed[chosen.agent.id] === false

  const start = async () => {
    setError('')
    setBusy(true)
    try {
      const view = await window.hub.sessions.start({ profileId, agentKey, cwd, cols: 100, rows: 30, model: readPrefs().models[agentKey] })
      onOpenChange(false)
      onStarted(view.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
            options={agents.map((a) => ({ value: a.key, label: installed[a.agent.id] === false ? `${a.label} (${t('newSession.notInstalled')})` : a.label }))}
            placeholder={t('session.noAgents')}
          />
        </Field>
        <Field label={t('newSession.folder')}>
          <div className="flex gap-2">
            <Input aria-label={t('newSession.folder')} value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} />
            <IconButton
              label={t('newSession.browse')}
              icon={<FolderOpen className="size-4" />}
              className="border border-border bg-surface"
              onClick={() => void window.hub.pickFolder().then((d) => d && setCwd(d))}
            />
          </div>
        </Field>
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
