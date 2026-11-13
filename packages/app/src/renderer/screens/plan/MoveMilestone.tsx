import { ArrowRightLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { moduleScreens, type MoveMilestoneSummary, type Profile } from '@workhub/core'
import { Button, Select, Spinner } from '../../components/atoms'
import { Dialog, Field, useToast } from '../../components/molecules'
import { useConfig } from '../../configStore'
import { useI18n } from '../../i18n/I18nProvider'
import { errorText } from '../../lib/errorText'

/** The profiles a milestone of `from` can move to: the others with Plan on. */
export function moveTargets(profiles: readonly Profile[], from: string): Profile[] {
  return profiles.filter((p) => p.id !== from && moduleScreens(p.modules).includes('planner'))
}

/**
 * "Move to profile" on a milestone: picks another profile with Plan on, says what goes with the
 * milestone (its items, copies of shared ones, tickets kept on the first tracker) and moves it.
 * After the move the milestone opens in its new profile.
 */
export function MoveMilestoneButton({ profile, milestoneId, name }: { profile: Profile; milestoneId: string; name: string }) {
  const { t, tn } = useI18n()
  const toast = useToast()
  const snap = useConfig()
  const targets = moveTargets(snap?.config.profiles ?? [], profile.id)
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [preview, setPreview] = useState<MoveMilestoneSummary | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open || !target) return setPreview(null)
    let alive = true
    void window.hub.planner.moveMilestonePreview(profile.id, milestoneId, target).then((p) => alive && setPreview(p), () => alive && setPreview(null))
    return () => {
      alive = false
    }
  }, [open, target, profile.id, milestoneId])

  if (targets.length === 0) return null
  const targetName = targets.find((p) => p.id === target)?.name ?? ''
  const move = async () => {
    setBusy(true)
    try {
      const r = await window.hub.planner.moveMilestone(profile.id, milestoneId, target)
      if (!r.ok) return toast(r.error, 'danger')
      setOpen(false)
      toast(t('planner.move.done', { name, profile: targetName }))
      window.hub.planner.openWindow({ profileId: target, kind: 'milestone', id: r.id })
      // The milestone's own window would only say it is gone: it closes (never the main window, which shows Plan).
      if (window.location.hash.startsWith('#plan-item')) window.close()
    } catch (e) {
      toast(errorText(e), 'danger')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button size="sm" variant="ghost" icon={<ArrowRightLeft className="size-3.5" aria-hidden />} data-testid="milestone-move" onClick={() => setOpen(true)}>
        {t('planner.move.button')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setTarget('')
        }}
        title={t('planner.move.title', { name })}
        description={t('planner.move.body', { profile: profile.name })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('planner.move.cancel')}
            </Button>
            <Button variant="primary" disabled={!target || !preview || busy} onClick={() => void move()} data-testid="milestone-move-confirm">
              {busy ? <Spinner className="size-4" /> : t('planner.move.confirm')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={t('planner.move.target')}>
            <Select aria-label={t('planner.move.target')} value={target} onChange={setTarget} placeholder={t('planner.move.pick')} options={targets.map((p) => ({ value: p.id, label: p.name }))} />
          </Field>
          {preview && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted" data-testid="milestone-move-preview">
              <li>{preview.moved ? tn('planner.move.moved', preview.moved) : t('planner.move.movedNone')}</li>
              {preview.copied > 0 && <li>{tn('planner.move.copied', preview.copied)}</li>}
              {preview.pinned > 0 && <li>{tn('planner.move.pinned', preview.pinned, { profile: profile.name })}</li>}
            </ul>
          )}
        </div>
      </Dialog>
    </>
  )
}
