import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { parsePrWindowHash } from './lib/pullRequests'
import { parseTicketHash, TicketWindowRoot } from './screens/TicketWindow'
import { TRAY_POPOVER_HASH } from '@shared/tray-api'
import { readPrefs } from './lib/prefs'
import { applyAppearance } from './lib/appearance'
import { PullRequestWindow } from './screens/PullRequestWindow'
import { TrayPopover } from './screens/TrayPopover'
import { SessionWindowRoot, SubagentWindowRoot } from './screens/SessionWindow'
import { parseSessionWindowHash, parseSubagentWindowHash } from './lib/windows'
import './styles.css'

// Set the theme (and the text sizes) before the first paint so a light OS never flashes the dark palette.
applyAppearance(readPrefs(), matchMedia('(prefers-color-scheme: dark)').matches)

// Secondary windows load the same bundle and are routed by the URL hash:
// `#tray-popover` is the menu bar popover, `#pr?profile=…&url=…` is a pull request, `#/ticket?profile=…&key=…`
// a ticket, `#session?id=…` a session in its own window and `#subagent?session=…&id=…` a sub-agent's conversation.
function root(hash: string): ReactElement {
  if (hash === TRAY_POPOVER_HASH) return <TrayPopover />
  const session = parseSessionWindowHash(hash)
  if (session) return <SessionWindowRoot sessionId={session.sessionId} />
  const subagent = parseSubagentWindowHash(hash)
  if (subagent) return <SubagentWindowRoot sessionId={subagent.sessionId} subagentId={subagent.subagentId} />
  const pr = parsePrWindowHash(hash)
  if (pr) return <PullRequestWindow profileId={pr.profileId} url={pr.url} tab={pr.tab} />
  const ticket = parseTicketHash(hash)
  if (ticket) return <TicketWindowRoot profileId={ticket.profileId} ticketKey={ticket.key} />
  return <App />
}

createRoot(document.getElementById('root')!).render(root(location.hash))
