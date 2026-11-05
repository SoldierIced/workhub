import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { parsePrWindowHash } from './lib/pullRequests'
import { parseTicketHash, TicketWindowRoot } from './screens/TicketWindow'
import { parseSettingsHash, SettingsWindowRoot } from './screens/SettingsWindow'
import { TRAY_POPOVER_HASH } from '@shared/tray-api'
import { readPrefs } from './lib/prefs'
import { applyAppearance, useAppliedAppearance } from './lib/appearance'
import { PullRequestWindow } from './screens/PullRequestWindow'
import { TrayPopover } from './screens/TrayPopover'
import { SessionWindowRoot, SubagentWindowRoot } from './screens/SessionWindow'
import { parseSessionWindowHash, parseSubagentWindowHash } from './lib/windows'
import { parseSetupHash, SetupWindow } from './screens/SetupWindows'
import { parseFileHash, parseReviewHash } from './lib/localReview'
import { LocalReviewWindow } from './screens/LocalReviewWindow'
import { FileViewerWindow } from './screens/FileViewerWindow'
import { FlowMapWindow, parseFlowMapHash } from './screens/flowMaps/FlowMapWindow'
import { PlanItemWindow } from './screens/plan/PlanItemWindow'
import { parsePlanItemHash } from '@shared/plan-item-window'
import { parseReviewLoopHash } from '@shared/review-loop-window'
import { ReviewLoopWindow } from './screens/sessions/ReviewLoopWindow'
import { startPerfReports } from './lib/perfReport'
import './styles.css'

// Set the theme (and the text sizes) before the first paint so a light OS never flashes the dark palette.
applyAppearance(readPrefs(), matchMedia('(prefers-color-scheme: dark)').matches)
// Long tasks and uncaught errors of every window go to the main log (Help → Reveal Logs).
startPerfReports()

// Secondary windows load the same bundle and are routed by the URL hash:
// `#tray-popover` is the menu bar popover, `#pr?profile=…&url=…` is a pull request, `#/ticket?profile=…&key=…`
// a ticket, `#session?id=…` a session in its own window and `#subagent?session=…&id=…` a sub-agent's conversation.
// `#review?session=…` a session's local review, `#file?path=…` the file viewer, `#flow-map?…` a flow map and
// `#plan-item?profile=…&kind=inbox|milestone&id=…` a Plan inbox item or milestone, `#review-loop?id=…` a review loop and
// `#settings?section=…` Settings (`section=general%23updates` also points at a group).
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
  const setup = parseSetupHash(hash)
  if (setup) return <SetupWindow page={setup} />
  const review = parseReviewHash(hash)
  if (review) return <LocalReviewWindow sessionId={review.sessionId} />
  const file = parseFileHash(hash)
  if (file) return <FileViewerWindow path={file.path} />
  const flowMap = parseFlowMapHash(hash)
  if (flowMap) return <FlowMapWindow {...flowMap} />
  const planItem = parsePlanItemHash(hash)
  if (planItem) return <PlanItemWindow {...planItem} />
  const reviewLoop = parseReviewLoopHash(hash)
  if (reviewLoop) return <ReviewLoopWindow loopId={reviewLoop.loopId} />
  const settings = parseSettingsHash(hash)
  if (settings) return <SettingsWindowRoot {...settings} />
  return <App />
}

/** Secondary windows follow a theme change made in another window. */
function Themed({ children }: { children: ReactElement }): ReactElement {
  useAppliedAppearance()
  return children
}

createRoot(document.getElementById('root')!).render(<Themed>{root(location.hash)}</Themed>)
