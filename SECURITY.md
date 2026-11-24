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
- `secrets.json`: API tokens you type into Settings, and the private addresses of calendars (Plan), encrypted with Electron `safeStorage`
  (macOS Keychain, Windows DPAPI, Linux libsecret/kwallet). Workhub refuses to store a secret when
  OS encryption is unavailable and never writes one in plain text.
- `workhub.db` (a SQLite database with owner-only file permissions on macOS and Linux) and its
  daily copies in `backups/`: open sessions, session names and windows, token spend,
  usage and budget ledgers, Slack and automation state, pull request events, alert state, Plan
  state (milestones, inbox, fired reminders and meeting briefs), flow maps and their history, live boards, and
  History's search index (the text of past Claude Code conversations: what you typed and the
  agent's answers, plus every session's title, first prompt, folder and branch). The
  `ai-review/` folder holds the AI review checkouts. These can contain session titles, repository
  names, meeting titles and Slack message text; they hold no credentials.

GitHub and GitLab access uses the `gh` and `glab` CLIs and your own sign-in; Workhub stores no
token for them. Slack is read through a Claude account's Slack connector; there is no Slack token.
Agent sessions use each agent's own credentials and configuration (for example a Claude config
folder) and are not copied.

## Network and system access

Workhub contacts only services you configure (code host, Jira or Linear, Elastic, agents) and,
when you turn on update checks (off by default), GitHub Releases. With Remote access on (off by
default) it also contacts the relay and the web push services described below. Reading Claude plan usage from
Anthropic's usage endpoint is opt-in. The
optional Slack tracking hook edits an account's `settings.json` only on request, keeps a `.bak`
copy, and removes only its own entry.

On request (an **Install** button or **Install what is missing**, after you confirm a list of what
will be downloaded) Workhub downloads tools into a `tools` folder in its data folder, never system
folders and never with administrator rights: Node.js from nodejs.org, MinGit (Windows) from the Git
for Windows releases, the GitHub CLI and the GitLab CLI from their official releases, and OpenCode,
Gemini CLI and Codex's session adapter from the npm registry. The addresses are fixed in the code
(`packages/core/src/setup/managed-tools.ts`), HTTPS only, at pinned versions; the windows only name
a tool, never an address or a command. Each archive is checked against the vendor's published
SHA-256 (Node.js, `gh` and `glab` checksum files; for MinGit the sums from the release notes, copied
into the code) before it is unpacked, and unpacking refuses absolute paths, `..` and links that
leave the folder. npm checks its packages against the registry's integrity hashes; Workhub allows
install scripts only for the one package it installs. The install scripts Workhub may run for
Claude Code, the Codex CLI and Kiro come from their vendors and have no published checksum. That
folder is put first on the `PATH` of the processes Workhub starts.

## Remote access (Workhub Remote)

Remote access is off by default. When you turn it on (Settings, Remote access) Workhub stores and
contacts the following; see [Remote access](docs/user-guide/remote-access.md) and
[the architecture notes](docs/architecture.md).

- **On this computer.** A key pair that identifies it (its seed lives in the secret store,
  `secrets.json`, next to your tokens), the relay address, and the list of paired devices with
  the capabilities you granted each one. A device can never pick a folder outside the profile's,
  skip permission prompts, open windows or dialogs on the desktop, read or change settings, or see
  secrets. Revoking a device in Settings drops it at once.
- **The relay.** Workhub connects to the relay you set: by default the one the project runs, or
  one you host yourself (`packages/relay`). Messages between the computer and a paired phone are
  end-to-end encrypted; the relay forwards ciphertext. It sees fingerprints, which computer a
  device talks to, message sizes and timing, IP addresses and push endpoints. It never sees
  message contents, session names, folders, prompts or notifications. It keeps no messages or
  accounts; the only thing it stores is where to send push notifications.
- **Push.** Notifications reach a phone that is offline through Web Push (the browsers' own push
  services). The body is sealed to the device's key, so the push service carries ciphertext.
  A notification about one waiting permission request can carry a **Deny** button, never
  **Allow**. Its push holds a one-time ticket for that device and that request, valid ten
  minutes; the phone's service worker sends the answer back through the relay sealed to the
  computer and signed with the device's key. The computer applies it only for that device, while
  it still has the sessions capability, and only while that request still waits; a used or old
  ticket, another device, or any other answer is refused.
- **Pairing.** The QR code (or its link) carries a one-time secret, valid for five minutes. Since
  anyone who sees the QR knows the secret, the phone also shows a 6-digit code made from the
  secret, both identities and a nonce the desktop signs after the phone answered; you type it on
  the desktop. A stranger's device gets a different code and cannot pick an identity that gives
  yours. A wrong code, or a second device answering the same QR, cancels the offer, and Settings
  says why.
- **On the phone.** Its own key pair, the last answers it received, encrypted with that key, and
  its push subscription, in the browser's storage for the relay's origin. The key is stored as
  an exportable seed (in local storage, mirrored to IndexedDB for the service worker): any script
  served from that origin can copy it and act as the phone until you revoke it. Serve nothing
  else from the relay's origin.
- **What the relay can do.** It serves the phone app's code, so a malicious relay operator could
  ship modified code that reads the keys on the phone. Pair only with a relay you trust;
  self-hosting is the safest choice, and the pairing screen shows the relay host to check.

Agents run with their own permission modes and MCP servers, and can execute code on your machine;
the effective permission mode of each session is shown in its header. Release builds are not
signed with a paid certificate or notarized yet; verify downloads with the `.sha256` files, and
check where a file was built with `gh attestation verify <file> --repo SoldierIced/workhub` (every
installer carries a signed build provenance attestation from the release workflow).
