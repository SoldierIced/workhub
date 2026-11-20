import { Shield, ShieldAlert } from 'lucide-react'
import type { SessionView } from '../../shared/api'
import { useI18n } from '../../renderer/i18n/I18nProvider'
import { cn } from '../../renderer/lib/cn'
import { sessionPermissionName } from '../../renderer/lib/sessionHeader'

/**
 * The permission mode the session really runs in, read-only: the phone never changes it. Tinted
 * while tools run without asking (the desktop does the same).
 */
export function PermissionBadge({ view }: { view: SessionView }) {
  const { t } = useI18n()
  const shown = sessionPermissionName(view, t)
  const unattended = view.permissionMode?.unattended === true
  const Icon = unattended ? ShieldAlert : Shield
  return (
    <span data-testid="permission-badge" title={t('session.permissionMode', { mode: shown })} className={cn('inline-flex max-w-full items-center gap-1 rounded-full px-2 py-px text-xs font-semibold', unattended ? 'bg-warning-soft text-warning' : 'bg-surface-hover text-muted')}>
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{shown}</span>
    </span>
  )
}
