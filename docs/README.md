# Workhub 2 documentation

Workhub 2 is a desktop app to run and supervise coding agents (Claude Code, Codex, Kiro, OpenCode,
Gemini CLI or any CLI) next to the pull requests, tickets, chat threads and environment health
around each task.

## For users

Start with [Getting started](user-guide/getting-started.md), or browse the [user guide](user-guide/README.md):

| Page | What it covers |
|---|---|
| [Getting started](user-guide/getting-started.md) | Install, the Welcome, the setup check, tools Workhub installs for itself, signing in |
| [Profiles](user-guide/profiles.md) | Folders, accounts, how links open, session environment |
| [Sessions](user-guide/sessions.md) | New session, App / Terminal / Shell, the composer, resume, windows, the sidebar; agents that propose sessions and message each other with your approval (`skills/workhub-sessions`) |
| [Monitor](user-guide/monitor.md) | The panel next to a session, and the Home screen |
| [Review before PR](user-guide/review-before-pr.md) | Have another agent review a branch, and review changes yourself |
| [Pull requests](user-guide/pull-requests.md) | The list, the pull request window, creating and merging |
| [Tickets](user-guide/tickets.md) | Jira, Linear and GitHub Issues |
| [Slack](user-guide/slack.md) | Watched channels and followed threads |
| [Health](user-guide/health.md) | Errors, pods and slow endpoints from Elasticsearch |
| [Remote access](user-guide/remote-access.md) | Workhub on your phone: pairing, what it can do, self-hosting the relay |
| [Flow maps](user-guide/flow-maps.md) | Diagrams of a business flow across services (⌘7), measured from APM, with its real executions; written by you or by an agent (`skills/workhub-flow-map`) |
| [Plan](user-guide/plan.md) | Today's and tomorrow's meetings from your calendars (⌘9), reminders, agent-prepared meeting briefs, the people you meet, milestones and an inbox; agents read and update it (`skills/workhub-plan`) |
| [Live boards](user-guide/live-boards.md) | A panel in the chat where a tool running in that session shows a job done by several agents while it happens: stages, who asks whom, agents, decisions, a log; off by default (`skills/workhub-board`) |
| [Cooking](user-guide/cooking.md) | A way of working for a change: type `/cooking` and the agent decides and records, has its plan and its result read by another model, and shows the job as a live board (`skills/workhub-cooking`); measured against other methods in [Cooking benchmarks](cooking-benchmarks.md) |
| [Automations](user-guide/automations.md) | Prompts sent to a dedicated session on an event or a schedule; agents can add and edit them, never turn them on (`skills/workhub-automations`) |
| [History](user-guide/history.md) | Past sessions, resumable; agents can read them (`skills/workhub-automations`) |
| [Usage and budgets](user-guide/usage.md) | Plan usage, ceilings, per-session limits, project budgets, token spend, how long data is kept; agents can read the usage data, read-only (`skills/workhub-analytics`) |
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
