# Contributing to Workhub 2

Thanks for helping. This guide covers setup, checks and what a pull request should look like.

## Setup

Requirements: Node.js 22, npm 10, and `gh` signed in if you work on pull request features.

Windows: nothing else to install. `npm ci` uses the prebuilt node-pty binaries, so the Visual Studio
Build Tools are not needed (node-pty's own source build requires the Spectre-mitigated libraries
component, which is why it is skipped; see `scripts/postinstall.mjs`). Running the tests without
administrator rights or Developer Mode skips the symbolic-link test. Known issue: quitting with a live
Shell session can print `Error: AttachConsole failed` from node-pty's `conpty_console_list_agent.js`;
it is a harmless race in node-pty's Windows kill path (the shell is already gone) and does not affect the app.
Linux needs `python3`, `make` and a C++ compiler for the node-pty build.

```sh
git clone https://github.com/SoldierIced/workhub.git
cd workhub
npm ci          # downloads Electron and prepares node-pty for it
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

## Releases

Versions and the [CHANGELOG](CHANGELOG.md) come from the Conventional Commits on `main`, through
[release-please](https://github.com/googleapis/release-please) (`release-please-config.json`,
`.release-please-manifest.json`, `.github/workflows/release-please.yml`). `feat`, `fix`, `perf` and
`revert` commits appear in the changelog; `docs`, `refactor`, `test`, `build`, `ci`, `chore` and
`style` are left out of it. Never edit the version by hand.

1. **Release pull request.** Every push to `main` that adds a `feat`, `fix`, `perf` or `revert`
   commit opens or updates a pull request titled `chore(main): release <next version>`. It bumps the root `package.json`,
   `packages/app/package.json`, `package-lock.json` and the manifest, and adds the new
   `CHANGELOG.md` entry. While the project is in alpha the next version is the next pre-release
   number (`2.0.0-alpha.1` → `2.0.0-alpha.2`), whatever the commit types.
2. **Cut the release.** Merge the release pull request. The run on that merge tags it
   (`v<version>`), creates a **draft** GitHub release with the changelog entry as its notes, and
   calls `.github/workflows/release.yml`, which builds the macOS, Windows and Linux installers and
   attaches them, with `.sha256` files and the `latest*.yml` update metadata, to the draft.
3. **Publish.** When the `release-please` workflow is green, open the draft on the Releases page,
   check the files and the notes, and publish it. A version with a suffix (`-alpha.N`, `-beta.N`)
   is published as a pre-release: only installs that run a pre-release are offered it by the
   in-app update check, and GitHub never shows it as the latest release.

The release pull request is opened by the workflow's own token, so it does not start the `ci`
workflow. If a branch rule requires `ci`, close and reopen the pull request (or push a commit to
its branch) to run the checks.

### Moving to beta or stable

- **Beta:** land a commit on `main` with a `Release-As` footer, for example
  `git commit --allow-empty -m "chore: release 2.0.0-beta.1" -m "Release-As: 2.0.0-beta.1"`.
  The release pull request then proposes `2.0.0-beta.1`, and later releases continue
  `2.0.0-beta.2`, `2.0.0-beta.3`. Also set `"prerelease-type": "beta"` in
  `release-please-config.json`.
- **Stable:** set `"prerelease": false` in `release-please-config.json` (the next release is
  `2.0.0`, published as a full release), or use a `Release-As: 2.0.0` footer. After `2.0.0`, switch
  `"versioning"` to `"default"` so the following versions bump normally (`fix` → `2.0.1`,
  `feat` → `2.1.0`, breaking change → `3.0.0`).
- Any other version, at any time: a `Release-As: <version>` footer.

### Manual fallback

When release-please cannot be used, set the same version in the root `package.json`,
`packages/app/package.json`, `package-lock.json` and `.release-please-manifest.json`, commit and
push, then push the tag: `git tag v<version> && git push origin v<version>`. `release.yml` checks
the tag against the version, builds the installers and creates the draft release (notes generated
by GitHub) for you to publish. `scripts/release.sh --dry-run`, then `--publish`, releases a macOS
build from your machine.

## Reporting problems

Open a GitHub issue with the steps to reproduce, your OS and the app version. For security
issues, do not open a public issue: follow [SECURITY.md](SECURITY.md).

By contributing you agree that your work is released under the [MIT license](LICENSE).
