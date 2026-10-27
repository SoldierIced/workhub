# Workhub 2

A cross-platform desktop app (Electron) to run and supervise coding agents such as Claude Code,
Kiro, OpenCode and Codex, plus any CLI. It is built next to the pull requests, tickets, chat
threads and environment health around each task. Agents declare their capabilities and the UI
shows only what each one supports. Nothing personal or company-specific is in the code: every
connection, profile and account is configuration loaded at runtime.

Status: phase P1 (core + config). macOS is the only platform exercised so far. See
[PLAN.md](PLAN.md) for the scope and the phases.

## Layout

```
packages/
  core/       Domain models, ports, use cases, config schema. Pure TypeScript: no Electron, no Node APIs.
  adapters/   Port implementations on Node/Electron:
                config-json       ConfigStore on a JSON file (atomic writes)
                secrets-electron  SecretStore on Electron safeStorage (+ an in-memory store)
                agent-acp         AgentRuntime over the Agent Client Protocol (Kiro, Claude via claude-agent-acp, OpenCode)
                agent-terminal    AgentRuntime over a PTY (node-pty) for any CLI
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

- macOS (Windows and Linux are planned, not tested yet)
- Node.js 22 and npm 10
- The agents you want to run, on your PATH (for example `kiro-cli`). The Claude ACP adapter is
  installed with the app.

## Install, run, test

```sh
npm install          # postinstall downloads the Electron binary and rebuilds node-pty for it
npm run dev          # the app in development mode
npm run typecheck    # tsc on every package
npm test             # Vitest: core and adapters
npm run build        # electron-vite build of the app (packages/app/out)
```

To run the built app: `cd packages/app && npx electron .`

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

## Privacy

No telemetry. Agents run with their own configuration (MCP servers, hooks, permission defaults),
so the effective permission mode of each session is shown in the session header.
