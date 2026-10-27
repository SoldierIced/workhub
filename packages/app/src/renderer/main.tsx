import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { parsePrWindowHash } from './lib/pullRequests'
import { parseTicketHash, TicketWindowRoot } from './screens/TicketWindow'
import { readPrefs } from './lib/prefs'
import { applyAppearance } from './lib/appearance'
import { PullRequestWindow } from './screens/PullRequestWindow'
import { parseFileHash, parseReviewHash } from './lib/localReview'
import { LocalReviewWindow } from './screens/LocalReviewWindow'
import { FileViewerWindow } from './screens/FileViewerWindow'
import './styles.css'

// Set the theme (and the text sizes) before the first paint so a light OS never flashes the dark palette.
applyAppearance(readPrefs(), matchMedia('(prefers-color-scheme: dark)').matches)

// Secondary windows load the same bundle and are routed by the URL hash:
// `#pr?profile=…&url=…` is a pull request, `#/ticket?profile=…&key=…` a ticket, `#review?session=…`
// a session's local review and `#file?path=…` the file viewer.
function root(hash: string): ReactElement {
  const pr = parsePrWindowHash(hash)
  if (pr) return <PullRequestWindow profileId={pr.profileId} url={pr.url} />
  const ticket = parseTicketHash(hash)
  if (ticket) return <TicketWindowRoot profileId={ticket.profileId} ticketKey={ticket.key} />
  const review = parseReviewHash(hash)
  if (review) return <LocalReviewWindow sessionId={review.sessionId} />
  const file = parseFileHash(hash)
  if (file) return <FileViewerWindow path={file.path} />
  return <App />
}

createRoot(document.getElementById('root')!).render(root(location.hash))
