# Workhub 2

A cross-platform desktop app (Electron) to run and supervise coding agents such as Claude Code,
Kiro, OpenCode and Codex, plus any CLI. It is built next to the pull requests, tickets, chat
threads and environment health around each task. Agents declare their capabilities and the UI
shows only what each one supports. Nothing personal or company-specific is in the code: every
connection, profile and account is configuration loaded at runtime.

Status: pre-release (`2.0.0-alpha.1`). macOS is the only platform exercised so far; Windows and
Linux installers are built by CI and untested. See [PLAN.md](PLAN.md) for the scope and the phases.

## Install

Download the installer for your OS from the
[Releases](https://github.com/SoldierIced/workhub/releases) page. The app is called **Workhub 2**
and installs next to Workhub 1 (different name, app id and data folder), so both can run. The
builds are **not signed with a paid certificate** yet, so each OS asks for one extra step on the
first launch. Every artifact has a `.sha256` file to check the download.

**macOS (Apple Silicon)**: open the `.dmg` and drag Workhub 2 to Applications (or unzip the `.zip`).
The app is signed ad hoc and not notarized, so Gatekeeper blocks the first launch: open the app
once, then go to System Settings > Privacy & Security, scroll to Security and click **Open Anyway**.
Or run `xattr -dr com.apple.quarantine "/Applications/Workhub 2.app"` and open it again.

**Windows (x64)**: run the `.exe`. SmartScreen shows "Windows protected your PC": click
**More info**, then **Run anyway**. The installer lets you pick the folder and installs per user.

**Linux (x64)**: `chmod +x Workhub-2-*-linux-x64.AppImage && ./Workhub-2-*-linux-x64.AppImage`, or
install the `.deb` (`sudo apt install ./Workhub-2-*-linux-x64.deb`).

The Claude Agent SDK and its `claude` binary ship inside the app, so Claude sessions work without
a separate Claude Code install. Other agents (`kiro-cli`, `opencode`, `gemini`, ...) must be on
your PATH. The Claude-over-ACP adapter (`claude-agent-acp`) is bundled too, but its launcher
needs Node.js on the PATH; the default native Claude agent does not.

### Updates

Settings > General > Updates has a **Check for updates** switch, off by default: nothing contacts
GitHub unless you turn it on or press **Check now**. Updates come from the GitHub Releases of
`SoldierIced/workhub` (pre-releases included while the version has a suffix). On Windows and on
Linux AppImage the app can download and install the new version. On macOS an unsigned app cannot
replace itself, so it only announces the new version and opens the release page: download it and
replace the app in Applications.

## Layout

```
packages/
  core/       Domain models, ports, use cases, config schema. Pure TypeScript: no Electron, no Node APIs.
  adapters/   Port implementations on Node/Electron:
                config-json       ConfigStore on a JSON file (atomic writes)
                secrets-electron  SecretStore on Electron safeStorage (+ an in-memory store)
                agent-claude-native  AgentRuntime on Workhub 1's Claude Agent SDK bridge (default for Claude):
                                  MCP status/reconnect/toggle, hooks, permissions, model switch, usage;
                                  also the session history and the opt-in plan usage read
                agent-acp         AgentRuntime over the Agent Client Protocol (Kiro, OpenCode, Codex via codex-acp, Gemini CLI, Claude via claude-agent-acp)
                agent-terminal    AgentRuntime over a PTY (node-pty) for any CLI
                transcript-claude TranscriptReader for Claude's JSONL transcripts (tokens, cost, tools, subagents, PRs, tickets)
                transcript-kiro / -opencode / -codex  TranscriptReader and history for Kiro, OpenCode (SQLite) and Codex rollouts
                workhub1-import   Reads Workhub 1's settings read-only (`defaults export`, macOS)
                codehost-github   CodeHost over the `gh` CLI (your own login, no token stored)
                codehost-gitlab   CodeHost over the `glab` CLI (fixture-tested only so far)
                tracker-jira      TicketTracker on Jira Cloud (REST v3, Agile API for sprints)
                tracker-linear    TicketTracker on Linear (GraphQL; cycles are sprints)
                tracker-demo      TicketTracker with synthetic tickets (WORKHUB_DEMO_TICKETS=1)
  app/        Electron shell: main process, preload bridge, React renderer (Tailwind + Radix design system, en/es)
spike/        P0 spike, kept as a reference (not part of the workspaces)
```

The dependencies point inward: `app` uses `adapters` and `core`; `adapters` implement the ports
in `core`; `core` depends on nothing but `zod`. Workspace packages ship TypeScript source and
the app bundles them with electron-vite, so there is no separate build step for `core` or
`adapters`.

## Requirements

- macOS, Windows or Linux (only macOS is tested so far)
- Node.js 22 and npm 10
- The agents you want to run, on your PATH (for example `kiro-cli`, `opencode`, `gemini`);
  Codex runs through `npx`. The Claude ACP adapter is installed with the app. An agent that is not
  installed shows as such in New session, with how to install it.

## Install, run, test

```sh
npm install          # postinstall downloads the Electron binary and rebuilds node-pty for it
npm run dev          # the app in development mode
npm run typecheck    # tsc on every package
npm test             # Vitest: core, adapters and app
npm run build        # electron-vite build of the app (packages/app/out)
```

To run the built app: `cd packages/app && npx electron .`

## Build installers

```sh
npm run dist          # installers for the current OS, into dist/
npm run dist:mac      # dmg + zip, arm64 (needs an Apple Silicon Mac)
npm run dist:win      # NSIS installer, x64 (run on Windows)
npm run dist:linux    # AppImage + deb, x64 (run on Linux)
npm run icons         # regenerate packages/app/build/icon.* from logo/workhub-logo.svg
scripts/install-mac.sh [--dry-run]   # build and install /Applications/Workhub 2.app
```

`node-pty` is a native module, so each OS builds its own installers (CI has one job per OS). The
build stages the Claude bridge (`scripts/stage-bridge.mjs`: the bridge scripts, the Agent SDK and
its native `claude` binary for the target) and ships it in the app's resources folder; `main`
finds it there instead of in the repo. The macOS build is signed with `WORKHUB_SIGN_IDENTITY`, else
the first "Apple Development" identity in your keychain, else ad hoc (`-`); it is never notarized.
`scripts/install-mac.sh` quits and reopens only "Workhub 2" and never touches `Workhub.app`;
`WORKHUB_KEEP_RUNNING=1` swaps the bundle without quitting it.

The product name, app id and release repository live in `scripts/brand.mjs` only (the app id is
`io.github.soldiericed.workhub2`); change them there when Workhub 2 replaces Workhub 1.

## Release process

The version is the root `package.json`'s (`packages/app/package.json` must match; the release
script checks). A version with a suffix (`2.0.0-alpha.1`) is published as a pre-release.

1. Set the version in both `package.json` files, commit, push.
2. Either push a tag: `git tag v2.0.0-alpha.1 && git push origin v2.0.0-alpha.1`. The `release`
   workflow checks the tag against the version, builds macOS, Windows and Linux installers and
   attaches them, with checksums and the `latest*.yml` update metadata, to a **draft** release.
   Review the draft and publish it.
3. Or release the macOS build from your machine: `scripts/release.sh --dry-run` prints the steps and
   the release notes; `scripts/release.sh --publish` builds, writes the `.sha256` files and runs
   `gh release create` (it refuses a dirty tree or a HEAD that is not pushed).

The `ci` workflow runs install, typecheck, tests and build on macOS, Windows and Linux for every
push to `main` and every pull request. No secrets are needed for unsigned builds. Signing and
notarization (Apple Developer ID, a Windows code-signing certificate) are a later step.

## Sessions

- **Claude Code** runs on the native adapter by default; **Claude Code (ACP)** stays selectable.
  Each Claude account is a config folder (`CLAUDE_CONFIG_DIR`); the session header shows it.
- Every session can switch between **App** (the chat), **Terminal** (the agent's own TUI, e.g.
  `claude --resume <id>`, the same conversation) and **Shell** (a shell in the session folder).
- The monitor reads Claude's transcript every 3 s. **Session history** lists every Claude session
  of the configured accounts, grouped by folder, resumable in the app or the terminal.
- **Other agents** (Kiro, OpenCode, Codex over ACP; Gemini CLI over `gemini --acp`) fill the monitor
  from their own files: Kiro credits and context, OpenCode cost and tokens (read-only SQLite),
  Codex tokens and 5 h / weekly rate limits. The history lists their sessions with an agent badge
  and filter; only Claude sessions can be resumed so far. These formats are internal: Kiro and
  OpenCode were checked on a real install, Codex only from its documentation (no data here).
- Plan usage per account comes from what running sessions report. Reading it from Anthropic's
  undocumented usage endpoint is an opt-in setting (Settings → General), off by default.
- **Import from Workhub 1** (Settings → General, macOS) previews profiles, folders, Claude
  accounts and connections (GitHub, Jira, Elastic), automations, the Slack watcher, Health
  environments, the profile modules they use, notification and usage options, the model per
  account, the sidebar session groups and the appearance (terminal theme, font and size, text
  sizes), before saving. Settings with no Workhub 2 equivalent are
  listed as not carried over. Applying twice adds nothing. Workhub 1 is never written; secrets are
  not copied (connections that need one are marked "re-enter").

- **Appearance** (Settings → Appearance): light or dark, plus the 485 terminal color schemes
  Workhub 1 offered (iTerm2-Color-Schemes, MIT; see `NOTICE`), searchable with a preview. "Use the
  theme across the app" colors every screen with the chosen scheme. Terminal font family and size,
  the app text size and the conversation text size are kept per install.

### Session groups

- Group sessions in the sidebar: **New group**, drag a session onto a group (or use **Move to group**
  in its context menu or its options button), drag to reorder, **Move up / Move down** (also
  `Alt+Up` / `Alt+Down` on a focused row). Groups collapse, rename and delete; deleting keeps open
  sessions. Stored in `config.json` (`sessionGroups`, config version 3).
- Membership follows the session's stable identity (the agent's own session id), so it survives
  resume and the App/Terminal hand-over. A closed session stays in its group, dimmed; click it to
  reopen it at its place, or remove it from the group yourself.
- A session is flagged when it finishes a turn, asks for a permission or fails while it is not on
  screen; viewing it clears the flag. A group shows the count and its most urgent state (error,
  needs an answer, ready to review, working), folded or not; the Sessions item shows the total.
  Terminal agents count a terminal bell as "replied".
- OS notifications (named `<group> · <session>` for grouped sessions; click opens the session) can be
  switched off per kind in Settings, General.

## Where data lives

- `config.json`: connections, agent accounts, profiles. Never holds secrets, only `secretRef` keys.
- `secrets.json`: secrets encrypted with the OS keychain through Electron `safeStorage`. Workhub
  refuses to store a secret when OS encryption is unavailable.

The folder is, in order of precedence:

1. `WORKHUB_DATA_DIR`, when set.
2. `packages/app/.dev-data/` in a development run (git-ignored).
3. The app's `userData` folder in a packaged build.

## Smoke tests

Start the app with remote debugging and drive it over CDP:

```sh
cd packages/app
WORKHUB_DATA_DIR=/tmp/workhub-smoke npx electron . --remote-debugging-port=9222
node scripts/drive.mjs '[{"tap":"button[aria-label=Settings]"},{"shot":"screenshots/settings.png"}]'
```

Set `WORKHUB_DEMO_TICKETS=1` to serve synthetic tickets (Tickets screen, Home cards, ticket window)
without a Jira or Linear account.

## Pull requests

The Pull requests screen (⌘/Ctrl+2) and the Home cards read through the code host of the active
profile's connection, using the `gh` or `glab` CLI you already signed in with (`gh auth login`);
Workhub stores no token. Set `scope=org:my-org` (GitHub search qualifiers) or `scope=group:my/group`
(GitLab) in the connection's settings to narrow the search; without it, GitHub falls back to the
repos behind the profile's folders, then to everything you can see. `WORKHUB_DEMO_CODEHOST=1`
serves synthetic pull requests instead of a real host, for demos and screenshots.

## Slack and automations

The Slack screen (⌘/Ctrl+4) reads the channels set in Settings → Slack, on a schedule, through
the Slack connector of one of your Claude accounts: a headless, read-only query (tools that post
or change anything are refused). There is no Slack app and no token. Its state
(`slack-state.json`) is shared by every profile and account.

- **Followed threads.** The optional tracking hook (Settings → Slack, per account) records the Slack
  messages a Claude session sends, so Workhub follows that thread. It edits the account's
  `settings.json` only when you click Install (a `.bak` copy is kept) and Remove takes out only its
  own entry. You can also follow a thread by pasting its link.
- **One owner per thread.** Each thread wakes exactly one session, its owner. A wake types the
  replies into the owner when it is idle, or reopens it in its transcript's own folder when it is
  closed (never the folder the message was sent from). Threads close when their PR is merged or
  closed, or after a week without activity.
- **Archived threads.** Per profile, threads quiet for N minutes (default 15) fold into
  "Archived (n)" in the Slack screen and the session monitor. A session's most recent thread never
  folds. Archived threads are still watched, and a new reply brings them back.

The Automations screen (⌘/Ctrl+5) sends a prompt or slash command to a dedicated session when a PR
message arrives in a watched channel and/or every N minutes, within a time window and rate limits.
Each Slack event fires at most one run, even across restarts and profiles: the ledger lives in
`automations-state.json`. With "new session each run", the new session takes the old one's sidebar
place and the threads it listens to. The old session closes once it is idle, off screen, and no
thread wakes it.

`WORKHUB_DEMO_SLACK=1` serves synthetic channels instead of asking an agent and disables the hook
buttons. To drive runs without any model, use `packages/app/scripts/demo-agent.mjs` as a custom ACP
agent (`"command": "node", "args": ["<path>/demo-agent.mjs"]`). In demo mode,
`window.hub.slack.demo(...)` injects messages, replies and "a session sent a message" records.

## AI review before a pull request

On by default per profile (Settings → Profiles → AI review). When a dev session finishes a turn and
stays idle (60 s) on a branch with commits ahead of its base (`develop` by default), a reviewer agent
(the first agent with a chat in your order, or the one you pick) reviews the branch on its own
read-only checkout under the data folder, in one exhaustive pass, and sends the findings to the dev
session's chat. The next commits get a new round that verifies the earlier findings. The loop stops
at "Ready for PR" (no blocker or major left) and pauses for you, with a notification, when the
reviewer flags scope or design, a finding keeps coming back, the dev agent disputes one, or the
round limit (3) is reached. "Review before PR" in the session header starts a round by hand; the
Review panel sits in the session monitor. Nothing is fetched: run `git fetch` to refresh the base.

## Privacy

No telemetry. Agents run with their own configuration (MCP servers, hooks, permission defaults),
so the effective permission mode of each session is shown in the session header.
