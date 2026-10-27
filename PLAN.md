# Workhub 2 — Base Plan (Option B: one cross-platform app)

Status: Stage 1 done (public repo SoldierIced/workhub, release v0.2.0, 2026-10-26). Stage 2: P0 spike in progress. Source of truth for scope until a tracked task list exists.

## 1. Goal

A public, open-source desktop app to run and supervise **any coding agent** (Claude Code, Codex,
OpenCode, Kiro, Gemini CLI, …) across work contexts, next to the pull requests, tickets, chat threads
and environment health around each task. Runs on **macOS, Windows and Linux**. Anyone can use,
configure, fork and extend it without touching code tied to one company or one person.

Secondary goal: a public portfolio piece showing how the app was designed and built with AI.

## 2. Decisions already made

| # | Decision |
|---|---|
| D1 | Option B: a new cross-platform app instead of porting the Swift UI. The Swift app (Workhub 1) is the functional spec, not the code base. |
| D2 | Two stages: Stage 1 publishes the cleaned Swift app for macOS; Stage 2 builds Workhub 2 here. |
| D3 | Any agent, not Claude-only. Agents declare capabilities; the UI adapts. |
| D4 | Flows are a module each profile can turn off, but they ship in v2.0 (feature parity with Workhub 1). |
| D5 | Nothing personal or company-specific in code: everything is configuration loaded at runtime. |
| D6 | New logo. |
| D7 | Same GitHub repo for Workhub 1, with history rewritten (filter-repo, then delete and recreate the repo; a force-push leaves old SHAs reachable through `refs/pull/*`). |
| D8 | Agents connect through three adapter kinds: a **native** adapter where an SDK gives more than ACP (Claude Code through the Agent SDK, keeping MCP status/reconnect/toggle, hooks and usage), an **ACP** adapter for every agent that speaks the Agent Client Protocol (Kiro and OpenCode natively; Codex and Claude through adapters), and a **terminal** adapter (PTY) for any other CLI. Claude never drops to the ACP baseline. |
| D9 | The session monitor is independent of the session transport: one common monitor model filled by one transcript reader per agent. |

## 3. Stage 1 — Publish Workhub 1 (Swift, macOS)

Goal: public evidence fast, without the big refactor (that effort goes to Workhub 2).

1. Merge `feature/mejoras-progreso` into `main`; freeze other branches.
2. Clean HEAD: company fixtures (company names, ticket-key previews, real Slack ids, private skill
   path in `HealthQueries.swift`), owner name in tests.
3. Move owner values to configuration: release repo, integration branch (`develop`), protected
   branches, Health refresh floor, flow-test repo slug, prompts catalog (one language register).
   Hide owner-only tools (`review-repos`, `claude-migrate`, `usageChecker`) when not installed.
4. New logo and app icon.
5. LICENSE (MIT or Apache-2.0), README for strangers, CONTRIBUTING, SECURITY, issue/PR templates.
6. Rewrite history with `git filter-repo` (replace-text, replace-message for `Claude-Session`
   trailers, mailmap to a public email); verify with the scan commands from the audit.
7. Delete and recreate the GitHub repo, push, publish a fresh release.

## 4. Stage 2 — Workhub 2 architecture

### Stack (to confirm with a short spike)

| Concern | Choice | Why |
|---|---|---|
| Shell | Electron | One language end to end; agent SDKs and `node-pty` are Node. Tauri would add Rust plus a Node sidecar. |
| Language | TypeScript (strict) | |
| UI | React + Vite (electron-vite) | Largest contributor pool. |
| Terminal | xterm.js + node-pty (ConPTY on Windows) | Same code on all three OSes. |
| Secrets | Electron `safeStorage` / OS keychain | Keychain, Credential Manager, libsecret. |
| Storage | SQLite (better-sqlite3) + JSON config | |
| Tests | Vitest (core), Playwright (app) | |
| Packaging | electron-builder; Homebrew cask, winget, AppImage | |
| CI | GitHub Actions matrix: macOS, Windows, Linux | |

### Layout (hexagonal)

```
packages/
  core/        domain models, ports, use cases, flow engine — no Electron, no Node-only APIs where avoidable
  adapters/    agent-*, codehost-*, tracker-*, chat-*, health-*, secrets-*
  app/         Electron main + preload + React renderer
  cli/         optional, later: same core from a terminal
```

### Ports

| Port | First adapters | Notes |
|---|---|---|
| `AgentRuntime` | Claude Code (native, Agent SDK), ACP (Kiro, OpenCode, Codex via `codex-acp`), terminal (any CLI) | Capabilities: app mode, transcript, usage, history, hooks, models, MCP control. See D8. |
| `TranscriptReader` | Claude, Kiro, OpenCode, Codex | Fills the common monitor model. See "Session monitor" below. |
| `CodeHost` | GitHub; GitLab | Domain enums for review decision, CI, mergeability. One URL recognizer per host. |
| `TicketTracker` | Jira; Linear or GitHub Issues | Key pattern per provider; sprints/iterations optional. |
| `ChatSource` | Slack (via agent MCP, as today); Discord/Teams later | |
| `HealthProvider` | Elastic APM; Sentry or Datadog later | Signal-level capabilities. |
| `SecretStore` | OS keychain per platform | |
| `Notifier` | OS notifications per platform | |

### Session monitor

One common model per session: tokens and cost, tool calls (PRs and tickets are detected from them),
subagents, active time, plan usage. Each agent fills what it has; the UI hides what it lacks.

| Data | Claude | Kiro | OpenCode | Codex |
|---|---|---|---|---|
| Storage | `~/.claude/projects/*.jsonl` | `~/.kiro/sessions/<hash>/sess_*/messages.jsonl` (chat) and `~/.kiro/sessions/cli/<id>.json(l)` (ACP sessions) | `~/.local/share/opencode/opencode.db` (SQLite: `session_v2`, `session_message`) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Tool calls | yes | `tool_call` / `tool_result` with `kind` (edit, read, execute) | in `session_message` | `response_item` |
| Subagents | yes | `sub-executions/*.jsonl` | child sessions (`parent_id`) | child rollout files |
| Tokens / cost | yes | `contextUsage`, `usage_summary`, credits | `cost`, `tokens_*` per session | `token_count` events |
| Plan usage | undocumented OAuth endpoint | `usagePercentage` | none seen (API-key cost) | `rate_limits` (5 h, weekly) |

Verified on a real machine for Kiro 2.33.1 and OpenCode (2026-10-27); Codex from third-party
sources. These formats are internal and undocumented: every reader ships with fixture tests and
fails soft (missing data hides the field, never breaks the session).

P0 spike findings (2026-10-27, `spike/README.md`, logs in `spike/probe/out/`):
- Claude over ACP (`@agentclientprotocol/claude-agent-acp` 0.97.0) loads the whole Claude Code setup
  with an empty `mcpServers`: user MCP servers, claude.ai connectors, hooks, skills, agents and
  `defaultMode` (here `bypassPermissions`). It reports `usage_update` with cost; no MCP status or
  toggle over ACP, so the native adapter stays for Claude (D8).
- Kiro over ACP exposes `_kiro.dev/*` extensions: per-server MCP status and tool count
  (`commands/available`), `mcp/server_initialized`, `mcp/oauth_request`, `metadata` with context %
  and credits per turn, `subagent/list_update`. No reconnect/toggle method seen.
- Both take 10–15 s on `session/new` while they start their MCP servers: the UI needs a starting state.
- Workhub must show the effective permission mode of each session, since the agent's own default applies.

MCP: each agent loads its own MCP configuration; ACP `session/new` can add servers. Controlling
servers (status, reconnect, toggle) is agent-specific: full for Claude (native adapter), whatever
extensions each ACP agent exposes otherwise.

### Reuse from Workhub 1

Workhub 1 is Swift, so its UI code does not carry over, but these pieces do:

| Piece | How it is reused |
|---|---|
| `Bridge/*.mjs` (Node, Claude Agent SDK: sessions, MCP status/toggle, Slack hook) | Directly, as the native Claude adapter (P2) |
| `Localizable.strings` (en, es) | Seed for the UI copy of matching screens |
| `docs/flows/*.mmd` diagrams | Behavior spec of each screen and service |
| Flow engine, PR/ticket parsers, Health queries, prompts | Ported as specs plus tests, then TypeScript (P3–P7) |
| Screens, layout, shortcuts | The visual and navigation reference |

Everything must run on Windows, Linux and macOS: `CmdOrCtrl` shortcuts, per-platform window
chrome, `path` for every path, no macOS-only API without a platform guard.

### Configuration

- Connection registry: named connections `{kind, provider, endpoint, secretRef, settings}`.
- Profiles bind connections per kind (code host, tracker, chat, health, agent accounts).
- N agent accounts per agent, not a fixed Personal/Work pair.
- Prompts are editable templates, with per-provider CLI hints.

### Optional modules

Flows, Health, Chat watcher, Automations. Each is enabled per profile and adds its screens only
when on. Flows keep the opinionated pipeline with per-step skip and a configurable base branch.

### AI review before a pull request

Goal: catch in one pass what a team review would find over many rounds (one pull request took 16).
When a dev session's work is committed, a reviewer agent reviews the branch before the pull request
and sends what to fix into the dev session's chat; the user is asked to step in when the loop drags.

- **Where:** pure logic in `core/src/ai-review` (settings, trigger decision, round state machine,
  escalation rules, reply parser, prompt and message builders, all unit-tested); git in
  `adapters/src/git-review`; the loop in `app/src/main/ai-review.ts`; the Review panel in the session
  monitor (`screens/sessions/AiReviewPanel.tsx`), "Review before PR" in the session header, settings
  per profile (Settings → Profiles → AI review). State: `ai-review-state.json` in the data folder.
- **Settings** (`profile.aiReview`, optional with zod defaults, no config version bump): on and
  automatic by default; reviewer agent (default: first agent with an app mode in the user's order);
  base branch `develop`; 3 rounds; 60 s idle debounce; extra checklist; prompt language (en, es).
- **Automatic trigger:** a dev session ends a turn and stays idle for the debounce; its folder is a
  git repo on a named branch that is not the base, main, master or develop; HEAD has commits ahead
  of the base ref and was not reviewed or attempted yet; no review is paused, running or waiting to
  deliver; one automatic review at a time. Uncommitted-only changes never trigger; uncommitted files
  are listed in the prompt and the panel. Never on reviewer sessions or inside review checkouts.
- **Base ref:** `origin/<base>`, else local `<base>`, else `origin/HEAD`, else main/master. Nothing is
  fetched: the ref is as fresh as the dev's last fetch (decision to confirm).
- **Isolation:** each round checks the reviewed HEAD out as a detached worktree under
  `<data>/ai-review/worktrees` (git hooks disabled, external diff and textconv refused) and removes it
  after the round; the dev's working tree is never touched. The reviewer starts read-only: Claude
  native in `plan` mode with Edit/Write/MultiEdit/NotebookEdit disallowed; an ACP agent with
  permission modes switches to `read-only`/`plan`/`ask` when it has one; every permission request
  of a reviewer is refused. Persona agents (Kiro) keep their mode; refusals are the guard there.
- **Rounds:** round 1 reviews the merge-base diff (cut at 150k characters; the reviewer reads the
  rest from its checkout), commits, ticket (monitor or branch name, title from the tracker) and the
  checklist, and asks for ONE exhaustive pass with severities and a scope assessment, ending in a
  fenced JSON block (`findings[]`, `previous[]`, `summary`, `scope`, `escalate`). Round N+1 reviews
  the delta since the last reviewed HEAD (full diff after a rebase) and verifies every open finding.
  A fresh reviewer session per round; the user's opinions go into the next prompt.
- **Delivery:** open findings go to the dev session as one message, blockers and majors first, asking
  it to fix and commit, or to answer `DISPUTE F<n>: <reason>`. No blocker or major open → "Ready for
  PR" (unsent minors still go once). Ready stops automatic rounds; the button starts another.
- **Escalation (pause + OS notification with the reason + attention flag):** the reviewer sets
  `escalate.needed` or rates the scope as too demanding / scope creep; the round limit is reached
  with blockers or majors open; a finding stays open after two fix attempts; the dev agent disputes
  a finding; the reply has no readable JSON (kept raw). The panel offers Continue (sends the
  findings, grants a round at the limit), per-finding status, dismiss selected, an opinion (sent to
  the dev now and to the reviewer next round), review again and stop.
- **Usage budget:** `canStartReview` asks the usage gate for the reviewer's account. Past the
  ceiling an automatic round is held ("Paused: usage budget", asked again every 5 min) and a manual
  one needs "Run anyway" (one-shot override).
- **Open decisions:** fetching the base before a round; whether "Ready for PR" should also stop
  manual rounds or re-arm automatic ones on later commits; a dedicated reviewer model setting.

## 5. Stage 2 — Phases (each one shippable)

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 Spike | Electron + xterm/node-pty terminal session; ACP client talking to Kiro and to Claude (`claude-agent-acp`); check whether the Claude ACP adapter loads `~/.claude` MCP servers and what MCP info Kiro exposes over ACP | Terminal and both ACP chats stream on macOS; Windows next |
| P1 Core + config | Monorepo, ports, domain models, connection registry, profiles, secret store, CI matrix | Core tests green on 3 OSes. Note (2026-10-27): first pass done on macOS only; the CI matrix and the Windows/Linux runs move to a follow-up. |
| P2 Sessions | Terminal agent (any command), native Claude adapter with app mode (App/Terminal/Shell views), transcript monitor, history, multiple Claude accounts, usage where available, Workhub 1 settings import | Daily use replaces Workhub 1 sessions screen |
| P3 Code host | GitHub adapter, PR list/detail/review; GitLab adapter | Same PR screen works on both |
| P4 Tickets | Jira adapter, Linear adapter, ticket ↔ PR ↔ session links | |
| P5 More agents | Kiro, OpenCode, Codex (`@agentclientprotocol/codex-acp`) and Gemini CLI (`--acp`) over ACP; Kiro/OpenCode/Codex readers and history (listing; resume later) | Two non-Claude agents usable with monitor data |
| P6 Modules | Chat watcher, Automations, Notifications, Health (Elastic) | Each toggled per profile |
| P7 Flows | Engine ported from Workhub 1 onto the ports | Flow runs on GitHub+Jira and GitLab+Linear |
| P8 Release | Signing (Apple notarization, Windows code signing), auto-update, docs site | Signed installers on 3 OSes |

## 6. Things easy to miss

- **Agent terms of service:** Workhub 1 reads Claude usage from an undocumented OAuth endpoint.
  In a public app this may break or violate terms; verify before shipping, or make it opt-in.
- **Name:** "Workhub" is likely used by other products; check before branding and buying a domain.
- **Signing costs:** Apple Developer (yearly fee) and a Windows code-signing certificate; without
  them users get Gatekeeper and SmartScreen warnings.
- **Windows specifics:** shells (PowerShell/cmd/WSL), paths, line endings, ConPTY quirks; agents
  that only run inside WSL.
- **Privacy:** no telemetry by default; say so in the README.
- **Maintenance budget:** decide how many issues/PRs you will handle; say it in CONTRIBUTING.
- **Migration:** keep Workhub 1 as the daily driver until P2/P3 reach parity; import its settings.
- **Localization:** English and Spanish from day one (Workhub 1 already has both).
- **Accessibility:** keyboard-first, screen-reader labels.
- **Portfolio value:** keep an `docs/ai-workflow.md` explaining how the app was built with agents.

## 7. Token estimate

Baseline: Workhub 1 took about **80M Claude tokens** to reach today's state (~45k lines Swift,
60 commits). All figures below are rough ranges derived from that baseline, not measurements.

Assumptions:
- The existing app is a written spec, which removes most product discovery (cheaper than v1).
- Scope is larger: 3 OSes, multi-agent, second adapters per domain, packaging and signing.
- Token counts include cached context the way the 80M baseline does.

| Item | Estimate (M tokens) |
|---|---|
| Stage 1: cleanup, config, docs, history rewrite, logo | 4 – 8 |
| P0 Spike | 2 – 4 |
| P1 Core + config + CI | 8 – 12 |
| P2 Sessions (terminal, Claude app mode, monitor, usage) | 15 – 25 |
| P3 Code host (GitHub + GitLab, PR review UI) | 10 – 15 |
| P4 Tickets (Jira + Linear) | 6 – 10 |
| P5 More agents | 6 – 12 |
| P6 Modules (chat, automations, notifications, health) | 12 – 20 |
| P7 Flows | 8 – 12 |
| P8 Release, signing, docs | 4 – 8 |
| QA, bug fixing, rework (≈20%) | 15 – 25 |
| **Total Stage 2** | **≈ 85 – 145** |
| **Total including Stage 1** | **≈ 90 – 150** |

How to keep it near the low end:
- Port the Flow engine and parsers logic first as specs plus tests, then code.
- Use Sonnet for well-specified adapters, Opus only for design and debugging.
- Ship phases in order. v2.0 reaches feature parity with Workhub 1 (owner decision, 2026-10-27), so P2–P7 are all in scope; Flows stays a module the user can turn off (D4).
- Cap unattended runs with the usage-budget hook.

## 8. Open decisions

1. Project name and logo.
2. License (MIT vs Apache-2.0).
3. Second adapter per domain (GitLab? Linear?).
4. Minimum feature set for a "v2.0" public release (suggested: P0–P4 plus the terminal agent).
5. Whether to buy signing certificates before v2.0.

## 9. Pending

- **Spend for API-key agents (deferred).** Usage per agent account (Settings → Usage) covers plan
  windows only: Claude and Codex accounts signed in with a subscription. Agents that run on API
  keys (OpenCode, Gemini with an API key) have no plan window; for them, show spend per day and
  per week from the token counts their sessions report, and the provider balance where an API
  exposes it (OpenRouter has one; Anthropic and OpenAI are still to be researched). Deferred by
  the user. Kiro stays "not available" until it exposes remaining credits or limits locally.
