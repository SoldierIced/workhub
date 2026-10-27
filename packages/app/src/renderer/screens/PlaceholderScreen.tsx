import { createElement } from 'react'
import { Badge } from '../components/atoms'
import { EmptyState } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/translate'
import { SCREEN_PHASE, type Route } from '../lib/nav'
import { ROUTE_ICON } from '../lib/routes'

const DESCRIPTION: Partial<Record<Route, MessageKey>> = {
  pullRequests: 'placeholder.pullRequests',
  tickets: 'placeholder.tickets',
  slack: 'placeholder.slack',
  automations: 'placeholder.automations',
  history: 'placeholder.history',
  flows: 'placeholder.flows',
  health: 'placeholder.health'
}

/** A screen that is planned but not built yet: what it will do and which phase brings it. */
export function PlaceholderScreen({ route, title }: { route: Route; title: string }) {
  const { t } = useI18n()
  const phase = SCREEN_PHASE[route] ?? ''
  const description = DESCRIPTION[route]
  return (
    <div className="flex h-full items-center justify-center p-8">
      <EmptyState
        icon={createElement(ROUTE_ICON[route], { className: 'size-6', 'aria-hidden': true })}
        eyebrow={<Badge tone="accent">{t('placeholder.phase', { phase })}</Badge>}
        title={title}
        description={description ? t(description) : undefined}
      />
    </div>
  )
}
