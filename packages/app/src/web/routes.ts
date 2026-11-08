// The phone app's screens, by URL hash. The desktop's push notifications open `#session/<id>`.
export type Route =
  | { screen: 'home' }
  | { screen: 'new' }
  | { screen: 'session'; id: string }
  | { screen: 'pullRequests' }
  | { screen: 'alerts' }
  | { screen: 'settings' }
  /** A pairing link (`#pair=<offer>`): the screen reads the offer from the hash itself. */
  | { screen: 'pair' }

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '')
  if (h.startsWith('pair=')) return { screen: 'pair' }
  if (h === 'new') return { screen: 'new' }
  if (h === 'prs' || h === 'pullRequests') return { screen: 'pullRequests' }
  if (h === 'alerts') return { screen: 'alerts' }
  if (h === 'settings') return { screen: 'settings' }
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
