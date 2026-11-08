// The phone app's screens, by URL hash. The desktop's push notifications open `#session/<id>`.
export const PLAN_TABS = ['today', 'inbox', 'tasks', 'milestones'] as const
export type PlanTab = (typeof PLAN_TABS)[number]

export type Route =
  | { screen: 'home' }
  | { screen: 'new' }
  | { screen: 'session'; id: string }
  | { screen: 'pullRequests' }
  | { screen: 'alerts' }
  | { screen: 'plan'; tab: PlanTab }
  /** An inbox item (a task, bug or decision). */
  | { screen: 'planItem'; id: string }
  | { screen: 'newItem' }
  | { screen: 'milestone'; id: string }
  | { screen: 'settings' }
  /** A pairing link (`#pair=<offer>`): the screen reads the offer from the hash itself. */
  | { screen: 'pair' }

const isPlanTab = (s: string): s is PlanTab => (PLAN_TABS as readonly string[]).includes(s)

/**
 * A hash may start with `d/<desktop fingerprint>/` (a notification from one of several paired
 * desktops): the fingerprint, and the hash without it.
 */
export function splitDesktop(hash: string): { desktop?: string; hash: string } {
  const m = /^#?\/?d\/([0-9a-f]{32})\/?(.*)$/.exec(hash)
  return m ? { desktop: m[1]!, hash: `#${m[2] ?? ''}` } : { hash }
}

export function parseRoute(hash: string): Route {
  const h = splitDesktop(hash).hash.replace(/^#\/?/, '')
  if (h.startsWith('pair=')) return { screen: 'pair' }
  if (h === 'new') return { screen: 'new' }
  if (h === 'prs' || h === 'pullRequests') return { screen: 'pullRequests' }
  if (h === 'alerts') return { screen: 'alerts' }
  if (h === 'settings') return { screen: 'settings' }
  if (h === 'plan') return { screen: 'plan', tab: 'tasks' }
  const plan = /^plan\/([^/?#]+)/.exec(h)
  if (plan) return { screen: 'plan', tab: isPlanTab(plan[1]!) ? plan[1]! : 'tasks' }
  if (h === 'item/new') return { screen: 'newItem' }
  const item = /^item\/([^/?#]+)/.exec(h)
  if (item) return { screen: 'planItem', id: decodeURIComponent(item[1]!) }
  const milestone = /^milestone\/([^/?#]+)/.exec(h)
  if (milestone) return { screen: 'milestone', id: decodeURIComponent(milestone[1]!) }
  const session = /^session\/([^/?#]+)/.exec(h)
  if (session) return { screen: 'session', id: decodeURIComponent(session[1]!) }
  return { screen: 'home' }
}

export function routeHash(route: Route): string {
  switch (route.screen) {
    case 'home':
      return '#'
    case 'new':
      return '#new'
    case 'session':
      return `#session/${encodeURIComponent(route.id)}`
    case 'pullRequests':
      return '#prs'
    case 'alerts':
      return '#alerts'
    case 'plan':
      return `#plan/${route.tab}`
    case 'planItem':
      return `#item/${encodeURIComponent(route.id)}`
    case 'newItem':
      return '#item/new'
    case 'milestone':
      return `#milestone/${encodeURIComponent(route.id)}`
    case 'settings':
      return '#settings'
    case 'pair':
      return '#'
  }
}

/** The screen a notification's route names; anything unknown goes home. */
export function routeFromNotification(route: string | undefined): Route {
  return route ? parseRoute(route) : { screen: 'home' }
}
