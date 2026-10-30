# Workhub 2 documentation

Workhub 2 is a desktop app to run and supervise coding agents (Claude Code, Codex, Kiro, OpenCode,
Gemini CLI or any CLI) next to the pull requests, tickets, chat threads and environment health
around each task.

## For users

Start with [Getting started](user-guide/getting-started.md), or browse the [user guide](user-guide/README.md):

| Page | What it covers |
|---|---|
| [Getting started](user-guide/getting-started.md) | Install, first run, the setup check |
| [Profiles](user-guide/profiles.md) | Folders, accounts, how links open, session environment |
| [Sessions](user-guide/sessions.md) | New session, App / Terminal / Shell, the composer, resume, windows, the sidebar |
| [Monitor](user-guide/monitor.md) | The panel next to a session, and the Home screen |
| [Review before PR](user-guide/review-before-pr.md) | Have another agent review a branch, and review changes yourself |
| [Pull requests](user-guide/pull-requests.md) | The list and the pull request window |
| [Tickets](user-guide/tickets.md) | Jira and Linear |
| [Slack](user-guide/slack.md) | Watched channels and followed threads |
| [Health](user-guide/health.md) | Errors, pods and slow endpoints from Elasticsearch |
| [Flow maps](user-guide/flow-maps.md) | Diagrams of a business flow across services (⌘7), measured from APM, with its real executions; written by you or by an agent (`skills/workhub-flow-map`) |
| [Automations](user-guide/automations.md) | Prompts sent to a dedicated session on an event or a schedule |
| [History](user-guide/history.md) | Past sessions, resumable |
| [Usage and budgets](user-guide/usage.md) | Plan usage, ceilings, per-session limits, token spend |
| [Settings](user-guide/settings.md) | What each Settings tab holds |
| [Keyboard shortcuts](user-guide/keyboard-shortcuts.md) | All shortcuts |

Something not working? See [Troubleshooting](troubleshooting.md).

## For contributors

- [Architecture](architecture.md): packages, ports and adapters, IPC and security, the data
  folder, how agents run, testing.
- [CONTRIBUTING.md](../CONTRIBUTING.md): setup, checks and pull request rules.
- [PLAN.md](../PLAN.md): the original scope and design record.
- [SECURITY.md](../SECURITY.md): what is stored where, and how to report a vulnerability.

The pages describe the app as it is in the source. Screenshots are not included yet.
