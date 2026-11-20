// The phone app's screens, by URL hash. The desktop's push notifications open `#session/<id>`.
export const PLAN_TABS = ['today', 'inbox', 'tasks', 'milestones'] as const
export type PlanTab = (typeof PLAN_TABS)[number]

export type Route =
  | { screen: 'home' }
  | { screen: 'new' }
  | { screen: 'session'; id: string }
  /** A sub-agent's conversation, of an open session. */
  | { screen: 'subagent'; sessionId: string; id: string }
  /** What an open session changed, and its review loop. */
  | { screen: 'changes'; sessionId: string }
  | { screen: 'pullRequests' }
  | { screen: 'alerts' }
  | { screen: 'automations' }
  | { screen: 'plan'; tab: PlanTab }
  /** An inbox item (a task, bug or decision). */
  | { screen: 'planItem'; id: string }
  | { screen: 'newItem' }
  | { screen: 'milestone'; id: string }
  | { screen: 'settings' }
  /** Search of past sessions (History). */
  | { screen: 'history' }
  /** A pairing link (`#pair=<offer>`): the screen reads the offer from the hash itself. */
  | { screen: 'pair' }

/** Decodes one hash segment; null when its percent-encoding is malformed (`%E0`). */
function decodeId(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

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
  if (h === 'automations') return { screen: 'automations' }
  if (h === 'settings') return { screen: 'settings' }
  if (h === 'history') return { screen: 'history' }
  if (h === 'plan') return { screen: 'plan', tab: 'today' }
  const plan = /^plan\/([^/?#]+)/.exec(h)
  if (plan) return { screen: 'plan', tab: isPlanTab(plan[1]!) ? plan[1]! : 'today' }
  if (h === 'item/new') return { screen: 'newItem' }
  const item = /^item\/([^/?#]+)/.exec(h)
  if (item) {
    const id = decodeId(item[1]!)
    return id === null ? { screen: 'home' } : { screen: 'planItem', id }
  }
  const milestone = /^milestone\/([^/?#]+)/.exec(h)
  if (milestone) {
    const id = decodeId(milestone[1]!)
    return id === null ? { screen: 'home' } : { screen: 'milestone', id }
  }
  const changes = /^session\/([^/?#]+)\/changes$/.exec(h)
  if (changes) {
    const sessionId = decodeId(changes[1]!)
    return sessionId === null ? { screen: 'home' } : { screen: 'changes', sessionId }
  }
  const subagent = /^session\/([^/?#]+)\/agent\/([^/?#]+)/.exec(h)
  if (subagent) {
    const sessionId = decodeId(subagent[1]!)
    const id = decodeId(subagent[2]!)
    return sessionId === null || id === null ? { screen: 'home' } : { screen: 'subagent', sessionId, id }
  }
  const session = /^session\/([^/?#]+)/.exec(h)
  if (session) {
    const id = decodeId(session[1]!)
    return id === null ? { screen: 'home' } : { screen: 'session', id }
  }
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
    case 'subagent':
      return `#session/${encodeURIComponent(route.sessionId)}/agent/${encodeURIComponent(route.id)}`
    case 'changes':
      return `#session/${encodeURIComponent(route.sessionId)}/changes`
    case 'pullRequests':
      return '#prs'
    case 'alerts':
      return '#alerts'
    case 'automations':
      return '#automations'
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
    case 'history':
      return '#history'
    case 'pair':
      return '#'
  }
}

/** The screen a notification's route names; anything unknown goes home. */
export function routeFromNotification(route: string | undefined): Route {
  return route ? parseRoute(route) : { screen: 'home' }
}

/** The tabs of the bottom bar, in order; each needs a capability the desktop granted (Settings needs none). Automations is reached from Settings. */
export const NAV_TABS = [
  { screen: 'home', need: 'sessions' },
  { screen: 'pullRequests', need: 'pullRequests' },
  { screen: 'plan', need: 'plan' },
  { screen: 'alerts', need: 'health' },
  { screen: 'settings' }
] as const
export type NavTab = (typeof NAV_TABS)[number]['screen']

/** The tabs a phone with these capabilities shows. */
export function navTabsFor(capabilities: readonly string[]): NavTab[] {
  return NAV_TABS.filter((tab) => !('need' in tab) || capabilities.includes(tab.need)).map((tab) => tab.screen)
}

/** The tab a screen belongs to: a chat belongs to Sessions, an item to Plan, Automations to Settings. */
export function tabOf(route: Route): NavTab | null {
  switch (route.screen) {
    case 'home':
    case 'session':
    case 'new':
    case 'subagent':
    case 'changes':
    case 'history':
      return 'home'
    case 'pullRequests':
      return 'pullRequests'
    case 'plan':
    case 'planItem':
    case 'newItem':
    case 'milestone':
      return 'plan'
    case 'alerts':
      return 'alerts'
    case 'settings':
    case 'automations':
      return 'settings'
    case 'pair':
      return null
  }
}

/** The session a screen is about, when it is one (its chat, its changes, one of its sub-agents). */
function sessionOf(route: Route): string | null {
  return route.screen === 'session' ? route.id : route.screen === 'subagent' || route.screen === 'changes' ? route.sessionId : null
}

/**
 * A notification about the session that is already on screen says nothing new: no toast for it.
 * One that needs an answer is dropped only when the session's own screen is open: the Changes and
 * sub-agent screens cannot show a permission request.
 */
export function isAboutOpenSession(
  payloadRoute: string | undefined,
  payloadDesktop: string | undefined,
  current: Route,
  currentDesktop: string | undefined,
  kind?: string
): boolean {
  if (!payloadRoute) return false
  if (payloadDesktop && currentDesktop && payloadDesktop !== currentDesktop) return false
  const open = sessionOf(current)
  if (open === null || open !== sessionOf(parseRoute(payloadRoute))) return false
  return kind === 'needsAnswer' ? current.screen === 'session' && parseRoute(payloadRoute).screen === 'session' : true
}
