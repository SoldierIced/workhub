# AGENTS.md

Notes for coding agents working on this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

Workhub 2 is an Electron app that runs and supervises coding agents. The repo is **public**.

## Layout and layering

npm workspace with five packages. Dependencies point inward only.

| Package | Role | May import |
|---|---|---|
| `packages/core` | Domain models, ports, use cases, config schema. Pure TypeScript, only `zod` at runtime. No Node or Electron APIs. | nothing in the repo |
| `packages/protocol` | Workhub Remote wire protocol: identities, pairing, the end-to-end encrypted channel, message schemas. Pure TypeScript for Node and the browser (`zod`, `@noble/*`). | nothing in the repo |
| `packages/relay` | The relay server (Node, `ws`, Web Push): rendezvous between a desktop and its paired devices, serves the web client. Stateless apart from push subscriptions. | `protocol` |
| `packages/adapters` | Port implementations on Node and Electron (agents, code hosts, trackers, calendars, storage). | `core` |
| `packages/app` | Electron main process, preload bridge, React renderer, and the web client for paired devices. | `core`, `adapters`, `protocol` |

Workspace packages ship TypeScript source and the app bundles them; there is no build step for
`core` or `adapters`. More in [docs/architecture.md](docs/architecture.md).

## Commands

```sh
npm ci               # install; downloads Electron and prepares node-pty
npm run typecheck    # tsc on every package
npm run lint         # ESLint, bug-catching rules only (its dependencies live in tools/lint)
npx vitest run       # all tests (npm test does the same)
npm run build        # electron-vite build of the app
npm run build:web -w @workhub/app   # phone app (Workhub Remote) into packages/relay/web-client
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
- **A release carries its notes**: before the release pull request is merged, `release-notes.json`
  gets that version's entry, written for users, in English and Spanish (CONTRIBUTING.md, Release
  notes). `packages/app/test/release-notes.test.ts` fails without it.
- Secrets never go to `config.json`; they go through the secret store (`secrets.json`, encrypted).

## Where things are

- Local control endpoint: `packages/app/src/main/control-server.ts`; Plan routes in
  `packages/app/src/main/plan-control.ts`. Unix socket on macOS and Linux (`WORKHUB_SOCKET`),
  loopback HTTP with a token on Windows. Every session also gets `WORKHUB_SESSION` and its own
  `WORKHUB_SESSION_TOKEN` (sent as `X-Workhub-Token`; `control-auth.ts` binds a request to it).
- Agent skills that teach agents those endpoints: `skills/workhub-plan`,
  `skills/workhub-flow-map`, `skills/workhub-board` (live boards, `POST /v1/boards`,
  `packages/app/src/main/boards.ts`), `skills/workhub-automations` (automations and history,
  `packages/app/src/main/automation-control.ts`) and `skills/workhub-analytics` (read-only usage
  data, `packages/app/src/main/analytics-control.ts`; the SQL checks are in
  `packages/adapters/src/sqlite-store/read-query.ts`, queries run in the `analytics-worker.ts` utility process) and
  `skills/workhub-sessions` (other sessions of the profile, proposals and messages the user approves,
  notifications, `packages/app/src/main/session-control.ts`), and
  `skills/workhub-review` (the user's review of the session's changes, `POST /v1/sessions/<id>/review`). Keep a skill in step with the endpoint it describes.
- `skills/workhub-cooking` teaches no endpoint: it is a way of working (the cooking method) that sends its
  job as a live board. The chat command `/cooking` (`packages/app/src/renderer/lib/chatCommands.ts`) starts it;
  its measured results are in `docs/cooking-benchmarks.md`, which describe the skill as it was measured.
- Live boards: the chat's board panel, `packages/app/src/renderer/screens/boards/ChatBoards.tsx` (module
  `boards`, no route of its own); the format and its limits are `packages/core/src/boards/` (`BOARD_LIMITS`, `parseBoard`).
- Settings screen: `packages/app/src/renderer/screens/SettingsScreen.tsx`, shown in its own window
  (`screens/SettingsWindow.tsx`, `main/settings-window.ts`).
- Product name, app id and release repository: `scripts/brand.mjs` only.
