import type { MessageKey } from '../i18n/translate'

/** Which panel a toggle folds: the sidebar (left) or the session monitor (right). */
export type PanelSide = 'left' | 'right'

/** What a panel's toggle shows, so its state reads at a glance: the icon, its label and whether it is pressed (panel shown). */
export interface PanelToggleLook {
  /** A lucide icon name: `PanelLeftClose` while the sidebar shows, `PanelLeftOpen` once folded (`Right` alike). */
  icon: 'PanelLeftClose' | 'PanelLeftOpen' | 'PanelRightClose' | 'PanelRightOpen'
  label: MessageKey
  pressed: boolean
}

export function panelToggle(side: PanelSide, hidden: boolean): PanelToggleLook {
  if (side === 'left') return { icon: hidden ? 'PanelLeftOpen' : 'PanelLeftClose', label: hidden ? 'layout.showSidebar' : 'layout.hideSidebar', pressed: !hidden }
  return { icon: hidden ? 'PanelRightOpen' : 'PanelRightClose', label: hidden ? 'layout.showMonitor' : 'layout.hideMonitor', pressed: !hidden }
}
