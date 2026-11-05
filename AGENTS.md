# AGENTS.md

Notes for coding agents working on this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

Workhub 2 is an Electron app that runs and supervises coding agents. The repo is **public**.

## Layout and layering

npm workspace with three packages. Dependencies point inward only.

| Package | Role | May import |
|---|---|---|
| `packages/core` | Domain models, ports, use cases, config schema. Pure TypeScript, only `zod` at runtime. No Node or Electron APIs. | nothing in the repo |
| `packages/adapters` | Port implementations on Node and Electron (agents, code hosts, trackers, calendars, storage). | `core` |
| `packages/app` | Electron main process, preload bridge, React renderer. | `core`, `adapters` |

Workspace packages ship TypeScript source and the app bundles them; there is no build step for
`core` or `adapters`. More in [docs/architecture.md](docs/architecture.md).

## Commands

```sh
npm ci               # install; downloads Electron and prepares node-pty
npm run typecheck    # tsc on every package
npx vitest run       # all tests (npm test does the same)
npm run build        # electron-vite build of the app
npm run dev          # development app ("Workhub 2 Dev")
npm run demo         # dev build with synthetic data in .demo-data/ (add -- --reset to reseed)
```

## Rules

- **Never restart or quit the user's installed Workhub to test a change.** Use `npm run dev` or
  `npm run demo`. A dev run keeps its data in `packages/app/.dev-data/`, the demo in `.demo-data/`;
  `WORKHUB_DATA_DIR` picks another folder. Never point a test run at a real install's data.
- **Every UI string goes through i18n**, in English and Spanish (`packages/app/src/renderer/i18n/`).
  `packages/app/test/i18n.test.ts` fails when the keys or placeholders differ.
- **Tests live next to the behavior**: Vitest, in the `test/` folder of the package you change.
  Add or update tests with every behavior change.
- **Docs follow behavior**: update `docs/user-guide/` (and the README, or `docs/architecture.md`)
  when a change is visible to users or changes the architecture.
- **Conventional Commits**: `feat(scope): ...`, `fix(scope): ...`, `docs: ...`. Release notes and
  versions are generated from them.
- **Public repo: synthetic data only.** No employer or company names, internal ticket keys, real
  service or repo names, chat channels, people, or home paths in code, tests, fixtures, docs,
  comments or commit messages. Use stand-ins such as `acme` and `example.com`.
- Secrets never go to `config.json`; they go through the secret store (`secrets.json`, encrypted).

## Where things are

- Local control endpoint: `packages/app/src/main/control-server.ts`; Plan routes in
  `packages/app/src/main/plan-control.ts`. Unix socket on macOS and Linux (`WORKHUB_SOCKET`),
  loopback HTTP with a token on Windows. Every session also gets `WORKHUB_SESSION`.
- Agent skills that teach agents those endpoints: `skills/workhub-plan` and
  `skills/workhub-flow-map`. Keep a skill in step with the endpoint it describes.
- Settings screen: `packages/app/src/renderer/screens/SettingsScreen.tsx`, shown in its own window
  (`screens/SettingsWindow.tsx`, `main/settings-window.ts`).
- Product name, app id and release repository: `scripts/brand.mjs` only.
