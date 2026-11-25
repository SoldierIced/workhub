import type { ReviewAction } from '@workhub/core'

/** Everything the PR panel keeps about the pull request it shows: it belongs to one URL and starts over for another. */
export interface PanelUi {
  url: string
  tab: string
  action: ReviewAction | null
  closing: boolean
  merging: boolean
}

export const initialPanelUi = (url: string, tab = 'conversation'): PanelUi => ({ url, tab, action: null, closing: false, merging: false })

/** The state for `url`: what was kept for it, or a fresh one when the panel moved to another PR (a dialog opened on A is gone on B). */
export const panelUiFor = (ui: PanelUi, url: string, tab?: string): PanelUi => (ui.url === url ? ui : initialPanelUi(url, tab))
