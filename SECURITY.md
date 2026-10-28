# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub security advisories:
<https://github.com/SoldierIced/workhub/security/advisories/new>. Do not open a public issue or
pull request for a security problem. Include the affected version, your OS, the steps to
reproduce and the impact. You will get an answer as soon as a maintainer can read it; this is a
volunteer project, so there is no guaranteed response time. Only the latest release is supported.

## What Workhub stores and where

Workhub runs locally and has no server and no telemetry. Its data folder is `WORKHUB_DATA_DIR` if
set, otherwise `packages/app/.dev-data/` in a development run, otherwise the app's `userData`
folder. It holds:

- `config.json`: connections, accounts, profiles and settings. It never holds secrets, only
  `secretRef` keys that point into the secrets file.
- `secrets.json`: API tokens you type into Settings, encrypted with Electron `safeStorage`
  (macOS Keychain, Windows DPAPI, Linux libsecret/kwallet). Workhub refuses to store a secret when
  OS encryption is unavailable and never writes one in plain text.
- State files: open sessions, session names and windows, token spend, usage and budget ledgers,
  Slack and automation state, pull request events, alert state and AI review checkouts. These
  can contain session titles, repository names and Slack message text; they hold no credentials.

GitHub and GitLab access uses the `gh` and `glab` CLIs and your own sign-in; Workhub stores no
token for them. Slack is read through a Claude account's Slack connector; there is no Slack token.
Agent sessions use each agent's own credentials and configuration (for example a Claude config
folder) and are not copied.

## Network and system access

Workhub contacts only services you configure (code host, Jira or Linear, Elastic, agents) and,
when you turn on update checks (off by default), GitHub Releases. Reading Claude plan usage from
Anthropic's usage endpoint is opt-in. Workhub 1 import is read-only and copies no secrets. The
optional Slack tracking hook edits an account's `settings.json` only on request, keeps a `.bak`
copy, and removes only its own entry.

Agents run with their own permission modes and MCP servers, and can execute code on your machine;
the effective permission mode of each session is shown in its header. Release builds are not
signed with a paid certificate or notarized yet; verify downloads with the `.sha256` files.
