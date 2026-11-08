# Architecture

For contributors. For setup and pull request rules see [CONTRIBUTING.md](../CONTRIBUTING.md); the
original scope and decisions are in [PLAN.md](../PLAN.md).

## Packages

An npm workspace with five packages. Dependencies point inward.

| Package | Role | May depend on |
|---|---|---|
| `packages/core` | Domain models, ports (interfaces), use cases, the config schema. Pure TypeScript; its only runtime dependency is `zod`. No Electron or Node APIs. | nothing in the repo |
| `packages/protocol` | The Workhub Remote wire protocol: device identities, pairing, the end-to-end encrypted channel and its message schemas. Pure TypeScript that runs in Node and the browser (`zod`, `@noble/curves`, `@noble/ciphers`, `@noble/hashes`). | nothing in the repo |
| `packages/relay` | The relay a desktop and its paired devices meet through: WebSocket rooms, presence, Web Push for devices that are offline, and the web client's files. It forwards bodies it cannot read. Bundled with esbuild into one file and shipped as a container image (`packages/relay/Dockerfile`). | `protocol` |
| `packages/adapters` | Implementations of the ports on Node and Electron: agents, code hosts, trackers, chat, health, calendars, storage, transcript readers. | `core` |
| `packages/app` | The Electron shell: main process, preload bridge and the React renderer (Tailwind and Radix, English and Spanish), plus the phone app for paired devices (`src/web/`: its own Vite entry and service worker, reusing the renderer's store, components and i18n over `window.hub`). | `core`, `adapters`, `protocol` |

Workspace packages ship TypeScript source and the app bundles them with electron-vite, so there is
no separate build step for `core`, `protocol` or `adapters`; only `relay` bundles itself for its image. `scripts/` holds build, release, icon and install
scripts; `spike/` is a historical spike and is not part of the workspaces.

```mermaid
flowchart LR
  subgraph app["packages/app (Electron)"]
    R["Renderer<br/>React UI"] -- "window.hub (contextBridge)" --> P["Preload"]
    P -- "IPC" --> M["Main process<br/>services and windows"]
  end
  M --> A["packages/adapters<br/>agents, code hosts, trackers,<br/>chat, health, storage"]
  M --> C["packages/core<br/>domain, ports, use cases"]
  A -- "implements ports" --> C
  A --> X["External: agent CLIs, gh/glab,<br/>Jira, Linear, Elasticsearch, files"]
```

## Ports and adapters (hexagonal)

`core` declares what the app needs; `adapters` supply it. Add behavior as a port in `core` plus an
adapter, not by reaching into a service from the UI.

| Port (in `core`) | Adapters |
|---|---|
| `AgentRuntime` | `agent-claude-native`, `agent-acp`, `agent-terminal` |
| Transcript readers (fill the common monitor model) | `transcript-claude`, `-kiro`, `-opencode`, `-codex` |
| Code host | `codehost-github` (`gh`), `codehost-gitlab` (`glab`) |
| Ticket tracker (capabilities: sprints, transitions, comments, assign, and the optional `search` and `create` that Plan uses) | `tracker-jira`, `tracker-linear`, `tracker-demo` |
| Chat source | `chat-slack` (through a Claude account's Slack connector) |
| Health provider | `health-elastic` |
| Calendar source (`CalendarSource`; ICS parsing, recurrence and rules are pure code in `core/calendar`) | `calendar-ics` (private ICS address over https, 20 s timeout, 5 MB cap; also the demo source) |
| `MetricSource` (daily samples for metric alerts) | Health's own read (`HealthMetricSource` in the main process), synthetic history in the Health demo |
| Config and secrets | `config-json`, `secrets-electron` (Electron `safeStorage`) |
| Other | `pr-events-json`, `git-review`, `git-worktree`, `token-spend`, `workhub1-import` |

Trackers declare optional capabilities too. `searchByQuery` (Jira: JQL through
`/rest/api/3/search/jql`, paged up to a cap; Linear: a project, or a team key and a label) counts
Plan's milestones, and `createIssue` (Jira: `POST /rest/api/3/issue` with an ADF description;
Linear: `issueCreate` in a team found by key) turns approved inbox items into issues. Both take a
generic priority from 1 (highest) to 4 that each adapter maps to its own scale. `readTickets` reads
tickets by key in one request (Jira: a `key in (…)` JQL search, key by key when Jira refuses the
batch for an unknown key; Linear: one issues query filtered by team key and number): Plan's
service reads the tickets of milestone pieces and of inbox items that follow a ticket with it, in
the same 30-minute cycle as the milestone counts, keeps their state in `planner-state.json` and
marks an item done when its ticket turns done. A tracker without these hides those features (a
ticket it cannot read stays in an unknown state, never counted as done).

Agents declare their capabilities (app mode, transcript, usage, plan usage, history, hooks, models,
MCP status and control, sub-agents, permission requests, image input, mid-turn input). The UI
derives what to show from them, so adding an agent does not mean touching the screens.

The session monitor is independent of the transport: one common model per session, filled by one
transcript reader per agent. Each reader works from the agent's own files, which are internal and
undocumented, so readers ship with fixture tests and fail soft: missing data hides the field and
never breaks the session.

## IPC and security model

- Every window has `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. The
  renderer has no Node. The only bridge is the preload script, which exposes one object,
  `window.hub`, with `contextBridge.exposeInMainWorld`. Its shape is typed in
  `packages/app/src/shared`, shared by main, preload and renderer. The object itself is built by
  `shared/hub-client.ts` over a `HubTransport` (invoke, send, subscribe): the preload passes
  Electron IPC; the web client for a paired phone passes a WebSocket to the desktop. Channel names
  live in that one file.
- Main registers IPC handlers through three wrappers. `guardIpc` checks that each message comes from
  the app's own renderer (the built `index.html`, or the dev server origin in a dev run); anything
  else is rejected. `timeIpc` times each handler and logs slow or failing ones, never their
  arguments. `recordIpc` (`main/remote/`) keeps every handler by channel so a paired device can
  reach the same code without Electron IPC.
- Remote access (`main/remote/dispatcher.ts`): a paired device calls `hub` methods and gets main's
  events over a transport of its own. The `RemoteHub` only routes channels in its allowlist
  (`main/remote/allowlist.ts`), each tied to a capability the user granted the device (sessions,
  pull requests, automations, health). Nothing that opens a dialog or a window on the desktop,
  reads or writes a path the device names, touches settings or secrets, or tests a connection is
  listed. A new session may only start in a folder the profile lists. Handlers that answer their
  sender (`sessions:promptStarted`) see the device as a sender of its own, with an id no window
  can have. The config snapshot reaches a device without the data folder path.
- Windows stay on the app's renderer: navigations and redirects away from it are refused (web links
  go to the default browser through the link service instead), `window.open` is denied and
  `<webview>` never attaches. This keeps a window that rendered untrusted Markdown (a pull request,
  a ticket) from becoming a remote page that still holds `window.hub`.
- Secondary windows load the same renderer bundle and are routed by the URL hash
  (`renderer/main.tsx`): a pull request (`#pr?…`), a ticket (`#/ticket?…`), a session or
  sub-agent, a local review, the file viewer, a flow map, and a Plan inbox item or milestone
  (`#plan-item?profile=…&kind=inbox|milestone&id=…`, `&edit=1` for its edit form, or
  `#plan-item?profile=…&kind=milestone&new=1` for a new milestone; built and read by
  `shared/plan-item-window.ts`). Main keeps one window per ticket, flow map or Plan item (an item's
  view and edit form share it; a profile has one new-milestone window) and focuses it when it is
  asked for again; asking to edit an item whose window is open sends it `planner:edit`. Plan
  changes (`planner:changed`) go to every window, so an item's window stays live.
- Settings is a window of its own too (`#settings?section=<id>`, `main/settings-window.ts`): one at
  a time; asking for it again focuses it and sends it `settings:navigate`, which goes through the
  unsaved-drafts guard. Its renderer reports whether drafts are unsaved, so the window's close
  button asks first. Every config write tells every window (`config:changed`, from a wrapper around
  the config store in `main/config-broadcast.ts`), so a change made there shows in the main window.
- Web permissions (camera, microphone, geolocation, notifications and so on) are denied by default;
  only sanitized clipboard writes from the app's own renderer are allowed.
- Secrets are never in `config.json`, only `secretRef` keys that point into `secrets.json`, which is
  encrypted with `safeStorage`. Workhub refuses to store a secret when OS encryption is
  unavailable. GitHub and GitLab access reuses the `gh` and `glab` sign-ins; Slack goes through a
  Claude account's connector. See [SECURITY.md](../SECURITY.md).
- The local control endpoint (`control-server.ts`) is HTTP. On macOS and Linux it listens on a Unix
  socket in the data folder (mode `0600`) and sessions get `WORKHUB_SOCKET`. On Windows it listens
  on a loopback HTTP port (127.0.0.1, random port) guarded by a per-launch token; sessions get
  `WORKHUB_URL` and `WORKHUB_TOKEN`, and requests send `Authorization: Bearer $WORKHUB_TOKEN`. Either
  way only the user's own processes reach it. Every session also gets `WORKHUB_SESSION`; a request acts on the profile of
  the session it names, else a named profile, else the active one. Bodies are capped at 256 KB and
  checked field by field. Endpoints: `POST /v1/sessions/:id/review` (open the human review),
  `POST /v1/flow-maps`, and Plan's (`plan-control.ts`): `GET /v1/plan/today`, `GET` and `POST
  /v1/inbox`, `PATCH /v1/inbox/:id` (local moves and fields, and linking an existing ticket:
  approving an item to the tracker stays a human action in the UI), `GET /v1/milestones` and `GET /v1/people` (no notes), and the
  agent milestone changes `POST /v1/milestones`, `PATCH /v1/milestones/:id` and `DELETE
  /v1/milestones/:id`. With the profile's `agentMilestones: ask` (the default) they answer 202 with
  `pending: true` and wait as proposals on the Milestones tab; with `allow` they answer 200 with
  `applied: true`. Changes go through the same services as the UI, which push change events to open windows. Agents learn
  them from the skills in `skills/` (`workhub-flow-map`, `workhub-plan`).
- Agents run with their own permission modes and MCP servers and can execute code on the machine.
  The effective permission mode of each session is shown in its header.

## Data folder

The data folder is, in order of precedence: `WORKHUB_DATA_DIR`; `packages/app/.dev-data/` in a
development run (git-ignored, and Electron's own files go in `electron/` inside it); the app's
`userData` folder in a packaged build. **Settings → Advanced → Data** shows the folder of the
running app.

| Entry | Contents |
|---|---|
| `config.json` | Connections, accounts, profiles, options. Never secrets. |
| `secrets.json` | Tokens, encrypted with `safeStorage`. |
| `control.sock` | The control endpoint's socket (macOS and Linux only; a temp folder when the data folder's path is too long. On Windows the endpoint is a loopback port and has no file). |
| `logs/` | `main.log` and rotated copies; see [Troubleshooting](troubleshooting.md#logs). |
| State files (`*.json`) | Open sessions, session names and windows, agent options, token spend, usage alerts and budgets (including per-session), API spend ledger, Slack state, automation state, pull request events, health alerts, metric alerts (`metric-alerts.json`: daily series and alerts per profile), ticket watch, Plan (`calendar-state.json`: reminders already fired and meeting briefs started, pruned after a few days; `planner-state.json`: milestones, their last tracker counts, the last known state of the tickets of milestone pieces and linked inbox items, and the inbox per profile, closed inbox items pruned after 7 days unless a milestone is made of them). Written through a small `StateFile` helper. They can hold session titles, repository names and Slack message text, and no credentials. |
| `ai-review/` | Read-only checkouts used by the review loop; its state is in `ai-review-state.json`. |
| `pasted-images/` | Images pasted into prompts. |
| `slack-hook/`, `kiro-usage/` | Support folders for the Slack tracking hook and the Kiro usage probe. |

## How agents run

Each session is one `AgentRuntime` in the main process, managed by the session manager, which also
reads the agent's transcript into the monitor and hands a session between views.

- **Native Claude Agent SDK bridge** (`agent-claude-native`): one bridge process per session
  (`bridge/bridge.mjs`), speaking one JSON object per line each way. The SDK drives Claude Code's
  own `claude` binary, so the user's settings, hooks, skills and MCP servers apply. It gives what
  ACP does not carry: MCP status and control, hooks, models, plan usage, images and joining a turn
  in progress. The bridge runs with Electron's own Node (`ELECTRON_RUN_AS_NODE`), so no Node install
  is needed; `scripts/stage-bridge.mjs` stages it with a locked dependency tree for packaging.
- **ACP** (`agent-acp`): the Agent Client Protocol over stdio (newline-delimited JSON-RPC), one agent
  process per session. Used for Kiro (`kiro-cli acp`), OpenCode (`opencode acp`), Codex (through
  `npx`, with the ACP adapter), Gemini CLI (`gemini --acp`) and Claude over the official ACP adapter
  as an alternative engine. Kiro's and others' extensions are used where they exist.
- **Terminal** (`agent-terminal`): any CLI, or a plain shell, over a PTY with `node-pty` (ConPTY on
  Windows) and xterm.js in the renderer. It backs the **Terminal** and **Shell** views. For Claude
  Code the terminal view runs `claude` with the same session id, so App and Terminal hand the same
  conversation back and forth.

Agent definitions (`builtin-agents.ts` in `core`) are data: id, command, adapter kind, capabilities,
mode semantics (permission levels, personas or none), the env variable of an account's config folder
and the transcript reader. Users can add their own in the config; a custom agent with the same id
replaces the built-in one. Sessions start with the login shell's `PATH`, since an app launched from
the Finder or a desktop launcher inherits a bare one.

## Testing

- Vitest, one project per package (`vitest.config.mts` at the root), all in the Node environment,
  with tests under each package's `test/` folder. `npm test` runs them all.
- `core` tests are pure unit tests. Adapters use fixtures for other tools' files and fake bridges or
  fake processes for runtimes; readers must fail soft. App tests cover the main-process services
  and the pure logic of the renderer.
- `npm run typecheck` runs `tsc` on every package; `npm run build` builds the app. CI runs install,
  typecheck, tests and build on macOS, Windows and Linux for every push to `main` and every pull
  request.
- User-facing text goes through the i18n tables in English and Spanish.
- Smoke tests drive a real app: start it with `--remote-debugging-port=9222` and use
  `packages/app/scripts/drive.mjs` over CDP. `packages/app/scripts/demo-agent.mjs` is a custom ACP
  agent that exercises automations without a model. The `WORKHUB_DEMO_*` environment variables serve
  synthetic tickets, pull requests, Slack, Health, calendar (`WORKHUB_DEMO_CALENDAR=1`) and usage data (see the
  [README](../README.md#development)). `npm run demo` (`scripts/demo.mjs`) sets them all plus
  `WORKHUB_DEMO_SCENARIO=team-lead`: `core/scenario` holds the synthetic "team lead" day as pure
  functions of `now`, and the main process seeds it into an isolated data folder (`demo-scenario.ts`).
