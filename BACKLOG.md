# Workhub 2 backlog — parity with Workhub 1 and open requests

Source: the user's last 40 messages (2026-10-27) plus a code audit of Workhub 1 vs Workhub 2.
Workhub 1 (`../workhub`, Swift) is read-only reference. All work lands in Workhub 2.

Update 2026-10-27 19:01: sections A–L merged to main (36ea322), pushed and installed. Open items per section are in the agents' reports; Flows dropped.

Status: `[x]` done on main · `[~]` in progress (branch) · `[ ]` pending.

## Already on main (from the earlier session)

- [x] Slack screen redesign, 485 themes, settings help texts and layout
- [x] Close sessions from the sidebar; App/Terminal hand-over without cutting the turn; terminals fit
- [x] Kiro and ACP model/agent pickers; Kiro credit spend
- [x] Claude account failover and hand-off between agents; preferred agent order per profile
- [x] Tray icon, menu and notifications; Health/ticket alerts
- [x] Workhub 1 import (config, Jira/Elastic tokens, themes); Slack automation off in v2
- [x] Slack threads archive after N quiet minutes (setting)
- [x] Raw config validation errors no longer shown

## A. Composer — branch `feat/composer-queue` (`../workhub2-composer`)

- [~] Type and send while the agent is working; messages queue
- [~] Pasted images render correctly
- [ ] Clicking a session focuses its chat composer

## B. Sidebar — branch `feat/sidebar-polish` (`../workhub2-sidebar-polish`)

- [~] Agent icon per session (Claude/Kiro/Codex), session name instead of "Claude Code", tooltip on long names
- [~] Settings header and tabs pinned while content scrolls
- [~] Badge with the sessions that need you on the app icon
- [ ] Settings open as a modal over the current screen instead of navigating to a Settings view
- [ ] Subagents listed under their session in the sidebar (v1 SubagentRows: chevron with count, retention, click opens the sub-agent view)
- [ ] Folder browser with search in the sidebar (v1 Favorites / Recent / All folders + filter)
- [ ] Profile colour bar on each session row (v1 `SidebarView` accent)
- [ ] A folder/group shows when a chat inside it replied or needs you
- [ ] Slack automation must not create several chats for the same thing, nor pull a session out of its folder

## C. Tray menu — branch `feat/tray-popover` (`../workhub2-tray-popover`)

- [~] Menu bar popover as good as v1's menu (v1 `MenuBarView.swift`)

## D. Session header and Monitor — branch `feat/session-header-monitor`

- [ ] Header ("Claude is running" area) compact like v1: one row, no wasted height, no wrapping; activity timer; Slack listening chip; account chip
- [ ] Monitor rebuilt after v1 `InspectorView.swift`: session time, tokens, context window, new tokens per request, activity, subagents, PRs touched, tickets, flow, MCP, local changes with review, memory project; v1 look and section order
- [ ] Image/header full width (item 8 of the 20:18 list)

## E. Health parity — branch `feat/health-parity`

- [ ] Select / Select all / Clear / Done on rows, and "Investigate together with Claude"
- [ ] "Investigate with Claude" on errors, pods, silent services and events (not only slow endpoints), fetching detail first and choosing the repo folder
- [ ] Drill-downs: top error groups and culprit, pod warning events and stderr, stderr card, system containers toggle
- [ ] Slow flows: span breakdown, resource table, window comparison
- [ ] Copy request for infra (pods); Kibana link per pod
- [ ] Alerts: service stops reporting, pod stops being ready, new worsening signal; one alert per subject per hour

## F. Slack, Jira and the PR window — branch `feat/slack-jira-pr`

- [ ] PR window layout: uses all the space, window title `repo#N`, no wasted strip, clear order (v1 `PRDetailView.swift`)
- [ ] Slack tab in the PR window; Slack badge on PR rows, Home PRs and session rows
- [ ] Track a Slack link with title, PR, ticket and wake fields
- [ ] Ticket: "New session about this ticket"; ticket chips on PRs with hover card; copy link and reload
- Flows by ticket: not ported (Flows dropped)

## G. Agents, accounts and usage — branch `feat/agents-usage`

- [ ] One place for agent configuration: Kiro listed in agent accounts, explain why there are several Claude entries, tooltips
- [ ] Usage shows Codex plan usage left; Kiro: credits left if any source exists (local data has none), otherwise spent
- [ ] Agent usage card compact, built for 3+ accounts (2 Claude + Kiro, Codex when installed): one row per window, short reset time, no wasted space
- [ ] Refresh button on the usage cards (Home and sidebar)
- [ ] Per-session usage budget: a different limit per session (new; v1 had none)
- [ ] API-token agents' spend: deferred by the user

## H. Home — branch `feat/home-usage`

- [ ] Home looks like v1's Home (layout, cards, spacing)
- [ ] Token spend per folder is always per profile and is ready on open, without waiting for a session to open (precomputed/cached, refreshed in the background)
- [ ] Evaluate the `codeburn` library/CLI for token accounting (license, data sources, Claude/Codex/Kiro support) before adopting it

## I. Local review and file viewer — branch `feat/review-files`

- [ ] Human local diff review: branch vs base / uncommitted, per-line comments, send N comments to the agent, "Looks good", multi-repo switcher, file filter, open on GitHub, delivery status in the Monitor
- [ ] File viewer window: text/image/PDF/folder/missing states, live reload, copy path, reveal, open in default app; "Files" list of what the agent read/edited; open pasted images in it

## J. Windows, menus, history — branch `feat/windows-history`

- [ ] Detach a session into its own window ("Move to Main Window"), "Open in New Window" (⇧⌘N, context menu); subagent window
- [ ] Native app menu with v1 shortcuts (new sessions ⌘T/⌘L/⌘Y, close ⇧⌘W, views, App/Console/Shell)
- [ ] Rename a session; per-folder "Resume session…" sheet with search
- [ ] History: context menu (resume in App/Console, reveal folder, copy session id), double-click resumes, "Open" chip, hide /tmp sessions, profile filter

## K. Setup, voice, profiles, notifications — branch `feat/setup-voice-profiles`

- [ ] Welcome window and setup check (node, gh, Claude logins, Jira, Slack, Health, usage) with fix buttons; "How Workhub works"
- [ ] Read replies aloud: per-session toggle, voice settings, stop speaking
- [ ] Profile settings: symbol, folder flags (only git repos, subfolders as projects), open links with, owns everything outside, env vars
- [ ] Notifications: master switch and OS-permission warning

## F additions

- [ ] PR list: context menu (open in new window, copy link), double-click opens window, narrowing bar (ticket, order, counts), Close PR with comment and delete branch

## Pending decision

- Flows: not ported (user decision, 2026-10-27).
- [ ] Automations editor: model, effort, permission mode fields

## M. Round 3 requests (2026-10-27 evening)

- [ ] Both side panes resizable; header items never overlap; Monitor sections scroll on their own; tray "…" removed
- [ ] Screen links (Home, PRs, Tickets, Slack, Automations, History, Health) move to the top bar
- [ ] Usage tooltips reliable; Kiro shown with % and reset like Claude; Kiro/Codex listed in Accounts; default permission mode per agent/account
- [ ] Settings: sticky save bar with unsaved-changes guard; Activate/Delete in the form header
- [ ] Profile default folder; "New session" starts the preferred agent there without asking

## Notes

- Test every change in "Workhub 2 Dev" (`WORKHUB_DATA_DIR` under /tmp), never in the installed app.
- Install into `/Applications/Workhub.app` only when asked, with `WORKHUB_KEEP_RUNNING=1` so the running app stays open.
