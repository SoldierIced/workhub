# Contributing to Workhub 2

Thanks for helping. This guide covers setup, checks and what a pull request should look like.

## Setup

Requirements: Node.js 22, npm 10, and `gh` signed in if you work on pull request features.

```sh
git clone https://github.com/SoldierIced/workhub.git
cd workhub
npm ci          # downloads Electron and rebuilds node-pty for it
npm run dev     # development app ("Workhub 2 Dev")
```

A development run keeps its data in `packages/app/.dev-data/` (git-ignored). Set
`WORKHUB_DATA_DIR` to use another folder, and never point a test run at a real install's data.
The README lists the `WORKHUB_DEMO_*` variables that serve synthetic data, so you can work on
tickets, pull requests, Slack, Health or usage without real accounts.

## Layout

`packages/core` is pure TypeScript (domain, ports, use cases, config schema). `packages/adapters`
implements the ports. `packages/app` is the Electron shell (main, preload, React renderer). Keep
dependencies pointing inward: `core` must not import Electron or Node APIs. Add behavior as a port
in `core` plus an adapter, rather than reaching into a service from the UI.

## Checks

Run these before opening a pull request; CI runs them on macOS, Windows and Linux:

```sh
npm run typecheck
npm test
npm run build
```

Add or update tests with the behavior you change (Vitest; readers for other tools' files use
fixtures and must fail soft). User-facing text goes through the i18n tables in English and
Spanish. Use `path` helpers and `CmdOrCtrl` shortcuts, and guard macOS-only APIs by platform.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope): ...`,
  `fix(scope): ...`, `docs: ...`, `chore: ...`, `test: ...`, `refactor: ...`.
- Keep a pull request focused and reviewable (roughly 400 changed lines is a good ceiling); split
  larger work into a chain of pull requests.
- Describe what changed and why, and how you verified it. Include a screenshot for UI changes.
- Update the README or other docs when behavior, settings or commands change.
- Never commit secrets, tokens, personal paths or company-specific names.

## Reporting problems

Open a GitHub issue with the steps to reproduce, your OS and the app version. For security
issues, do not open a public issue: follow [SECURITY.md](SECURITY.md).

By contributing you agree that your work is released under the [MIT license](LICENSE).
