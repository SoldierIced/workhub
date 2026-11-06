import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useI18n } from '../../i18n/I18nProvider'
import { panelToggle, type PanelSide } from '../../lib/panelToggle'
import type { Shortcut } from '../../lib/shortcuts'
import { IconButton } from '../atoms/IconButton'
import { Kbd } from '../atoms/Kbd'

const ICONS = { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen }

/** Shows or folds the sidebar or the session monitor; its icon tells which: an open panel shows "close", a folded one "open". */
export function PanelToggleButton({ side, hidden, shortcut, onToggle, size, testId }: { side: PanelSide; hidden: boolean; shortcut: Shortcut; onToggle: () => void; size?: 'sm' | 'md'; testId: string }) {
  const { t } = useI18n()
  const look = panelToggle(side, hidden)
  const Icon = ICONS[look.icon]
  return (
    <IconButton
      size={size}
      label={t(look.label)}
      hint={<Kbd shortcut={shortcut} />}
      icon={<Icon className="size-4" aria-hidden />}
      aria-pressed={look.pressed}
      data-testid={testId}
      data-panel={hidden ? 'hidden' : 'shown'}
      onClick={onToggle}
    />
  )
}
