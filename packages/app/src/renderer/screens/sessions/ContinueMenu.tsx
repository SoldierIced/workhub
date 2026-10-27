import { ArrowRightLeft, ChevronDown, Send, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SessionView } from '@shared/api'
import type { ContinuityOptions } from '@shared/continuity-api'
import { Badge, Button, Spinner } from '../../components/atoms'
import { useI18n } from '../../i18n/I18nProvider'
import { accountOfLabel, useContinuityActions } from '../../lib/continuity'

/**
 * The session header's "Continue elsewhere" menu: the same conversation in another Claude account,
 * or a hand-off brief for another agent (optionally written by this agent).
 */
export function ContinueMenu({ view }: { view: SessionView }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<ContinuityOptions | null>(null)
  const [summarize, setSummarize] = useState(false)
  const [running, setRunning] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const { failover, handoff } = useContinuityActions()

  useEffect(() => {
    if (!open) return
    setOptions(null)
    let alive = true
    void window.hub.continuity.options(view.id).then(
      (o) => alive && setOptions(o),
      () => alive && setOptions({ sessionId: view.id, mode: 'ask', failover: [], handoff: [], canSummarize: false })
    )
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      alive = false
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, view.id])

  const run = async (action: () => Promise<boolean>) => {
    setRunning(true)
    try {
      if (await action()) setOpen(false)
    } finally {
      setRunning(false)
    }
  }

  const busy = view.state === 'busy'
  const isClaude = view.agentId === 'claude'
  return (
    <div ref={root} className="relative">
      <Button size="sm" variant="ghost" aria-haspopup="menu" aria-expanded={open} icon={<ArrowRightLeft className="size-3" aria-hidden />} onClick={() => setOpen((o) => !o)} data-testid="continue-menu">
        {t('continuity.menu')}
        <ChevronDown className="size-3" aria-hidden />
      </Button>
      {open && (
        <div role="menu" aria-label={t('continuity.menu')} className="absolute top-full right-0 z-30 mt-1 w-80 rounded-lg border border-border bg-surface-raised p-2 text-sm shadow-lg">
          {!options ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-muted">
              <Spinner className="size-3.5" />
              {t('continuity.menu.loading')}
            </div>
          ) : (
            <>
              {busy && <p className="px-2 py-1.5 text-warning">{t('continuity.menu.busy')}</p>}
              {isClaude && (
                <section className="pb-1">
                  <h3 className="px-2 pt-1 text-2xs font-semibold tracking-wide text-subtle uppercase">{t('continuity.menu.accounts')}</h3>
                  <p className="px-2 pb-1 text-xs text-subtle">{t('continuity.menu.accountsHint')}</p>
                  {options.failover.length === 0 && <p className="px-2 py-1 text-muted">{t('continuity.menu.noAccounts')}</p>}
                  {options.failover.map((target) => (
                    <button
                      key={target.key}
                      type="button"
                      role="menuitem"
                      disabled={busy || running}
                      onClick={() => void run(() => failover(view, { targetKey: target.key, reason: 'manual' }))}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-hover disabled:opacity-50"
                    >
                      <UserRound className="size-3.5 text-muted" aria-hidden />
                      <span className="flex-1 truncate">{accountOfLabel(target.label)}</span>
                      {target.budget?.action === 'warn' && target.budget.percent !== undefined && <Badge tone="warning">{Math.round(target.budget.percent)}%</Badge>}
                    </button>
                  ))}
                </section>
              )}
              <section className={isClaude ? 'border-t border-border pt-1' : ''}>
                <h3 className="px-2 pt-1 text-2xs font-semibold tracking-wide text-subtle uppercase">{t('continuity.menu.handoff')}</h3>
                <p className="px-2 pb-1 text-xs text-subtle">{t('continuity.menu.handoffHint')}</p>
                {options.handoff.length === 0 && <p className="px-2 py-1 text-muted">{t('continuity.menu.noHandoff')}</p>}
                {options.handoff.map((target) => (
                  <button
                    key={target.key}
                    type="button"
                    role="menuitem"
                    disabled={running}
                    onClick={() => void run(() => handoff(view, target.key, target.label, summarize && options.canSummarize))}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-hover disabled:opacity-50"
                  >
                    <Send className="size-3.5 text-muted" aria-hidden />
                    <span className="flex-1 truncate">{target.label}</span>
                  </button>
                ))}
                {options.canSummarize && options.handoff.length > 0 && (
                  <label className="mt-1 flex items-center gap-2 px-2 py-1 text-xs text-muted">
                    <input type="checkbox" checked={summarize} onChange={(e) => setSummarize(e.target.checked)} />
                    {t('continuity.menu.summarize')}
                  </label>
                )}
                {running && (
                  <div className="flex items-center gap-2 px-2 py-1 text-muted">
                    <Spinner className="size-3.5" />
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  )
}
