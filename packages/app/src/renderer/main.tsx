import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { parsePrWindowHash } from './lib/pullRequests'
import { parseTicketHash, TicketWindowRoot } from './screens/TicketWindow'
import { readPrefs, resolveTheme } from './lib/prefs'
import { PullRequestWindow } from './screens/PullRequestWindow'
import './styles.css'

// Set the theme before the first paint so a light OS never flashes the dark palette.
document.documentElement.dataset['theme'] = resolveTheme(readPrefs().theme, matchMedia('(prefers-color-scheme: dark)').matches)

// Secondary windows load the same bundle and are routed by the URL hash:
// `#pr?profile=…&url=…` is a pull request, `#/ticket?profile=…&key=…` a ticket.
function root(hash: string): ReactElement {
  const pr = parsePrWindowHash(hash)
  if (pr) return <PullRequestWindow profileId={pr.profileId} url={pr.url} />
  const ticket = parseTicketHash(hash)
  if (ticket) return <TicketWindowRoot profileId={ticket.profileId} ticketKey={ticket.key} />
  return <App />
}

createRoot(document.getElementById('root')!).render(root(location.hash))
