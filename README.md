# Workhub 2

A cross-platform desktop app (Electron) to run and supervise coding agents such as Claude Code,
Kiro, OpenCode and Codex, plus any CLI. It is built next to the pull requests, tickets, chat
threads and environment health around each task. Agents declare their capabilities and the UI
shows only what each one supports. Nothing personal or company-specific is in the code: every
connection, profile and account is configuration loaded at runtime.

Status: phase P2 (sessions). macOS is the only platform exercised so far. See
[PLAN.md](PLAN.md) for the scope and the phases.

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
                agent-acp         AgentRuntime over the Agent Client Protocol (Kiro, Claude via claude-agent-acp, OpenCode)
                agent-terminal    AgentRuntime over a PTY (node-pty) for any CLI
                transcript-claude TranscriptReader for Claude's JSONL transcripts (tokens, cost, tools, subagents, PRs, tickets)
                workhub1-import   Reads Workhub 1's settings read-only (`defaults export`, macOS)
                codehost-github   CodeHost over the `gh` CLI (your own login, no token stored)
                codehost-gitlab   CodeHost over the `glab` CLI (fixture-tested only so far)
  app/        Electron shell: main process, preload bridge, React renderer (Tailwind + Radix design system, en/es)
spike/        P0 spike, kept as a reference (not part of the workspaces)
```

The dependencies point inward: `app` uses `adapters` and `core`; `adapters` implement the ports
in `core`; `core` depends on nothing but `zod`. Workspace packages ship TypeScript source and
the app bundles them with electron-vite, so there is no separate build step for `core` or
`adapters`.

## Requirements

- macOS (Windows and Linux are planned, not tested yet)
- Node.js 22 and npm 10
- The agents you want to run, on your PATH (for example `kiro-cli`). The Claude ACP adapter is
  installed with the app.

## Install, run, test

```sh
npm install          # postinstall downloads the Electron binary and rebuilds node-pty for it
npm run dev          # the app in development mode
npm run typecheck    # tsc on every package
npm test             # Vitest: core, adapters and app
npm run build        # electron-vite build of the app (packages/app/out)
```

To run the built app: `cd packages/app && npx electron .`

## Sessions

- **Claude Code** runs on the native adapter by default; **Claude Code (ACP)** stays selectable.
  Each Claude account is a config folder (`CLAUDE_CONFIG_DIR`); the session header shows it.
- Every session can switch between **App** (the chat), **Terminal** (the agent's own TUI, e.g.
  `claude --resume <id>`, the same conversation) and **Shell** (a shell in the session folder).
- The monitor reads Claude's transcript every 3 s. **Session history** lists every Claude session
  of the configured accounts, grouped by folder, resumable in the app or the terminal.
- Plan usage per account comes from what running sessions report. Reading it from Anthropic's
  undocumented usage endpoint is an opt-in setting (Settings → General), off by default.
- **Import from Workhub 1** (Settings → General, macOS) previews profiles, folders, Claude
  accounts and connections before saving. Workhub 1 is never written; secrets are not copied.

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

## Pull requests

The Pull requests screen (⌘/Ctrl+2) and the Home cards read through the code host of the active
profile's connection, using the `gh` or `glab` CLI you already signed in with (`gh auth login`);
Workhub stores no token. Set `scope=org:my-org` (GitHub search qualifiers) or `scope=group:my/group`
(GitLab) in the connection's settings to narrow the search; without it, GitHub falls back to the
repos behind the profile's folders, then to everything you can see. `WORKHUB_DEMO_CODEHOST=1`
serves synthetic pull requests instead of a real host, for demos and screenshots.

## Privacy

No telemetry. Agents run with their own configuration (MCP servers, hooks, permission defaults),
so the effective permission mode of each session is shown in the session header.
