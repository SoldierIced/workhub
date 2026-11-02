# Getting started

## Requirements

- macOS, Windows or Linux. Only macOS has been tested on real machines so far.
- The agents you want to run, installed and on your `PATH` (for example `kiro-cli`, `opencode`,
  `gemini`). Codex runs through `npx`, which comes with Node.js. An agent that is not installed
  shows as **not installed** in **New session**, with how to install it.
- Claude Code needs no separate install: the Claude Agent SDK and its `claude` binary ship inside
  the app. Sign in with a Claude account from the setup check.
- `gh` (GitHub CLI) signed in for pull requests, and `glab` for GitLab.

## Install

Download the installer for your system from the
[Releases](https://github.com/SoldierIced/workhub/releases) page. Every file has a `.sha256` file
to check the download. The builds are not signed with a paid certificate, so each system asks for
one extra step the first time you open the app.

A release is created as a **draft** and only its owner sees drafts until it is published. If no
release is published yet, build from source: see the README, [macOS from source](../../README.md#install)
and [Build installers](../../README.md#build-installers).

| System | File | First launch |
|---|---|---|
| macOS (Apple Silicon) | `.dmg` or `.zip` | Drag **Workhub 2** to Applications. Gatekeeper blocks the first launch: open the app once, then go to **System Settings → Privacy & Security**, scroll to **Security** and click **Open Anyway**. Or run `xattr -dr com.apple.quarantine "/Applications/Workhub 2.app"`. |
| Windows (x64) | `.exe` installer | SmartScreen shows "Windows protected your PC": click **More info**, then **Run anyway**. The installer lets you pick the folder and installs per user. |
| Linux (x64) | `.AppImage` or `.deb` | `chmod +x Workhub-2-*-linux-x64.AppImage && ./Workhub-2-*-linux-x64.AppImage`, or `sudo apt install ./Workhub-2-*-linux-x64.deb`. |

Workhub 2 has its own app id and data folder, so it can run next to Workhub 1.

### Windows from zero

Windows is built by CI and has not been tested on real machines yet. Please report what you find.

1. Install the prerequisites. Install [Git for Windows](https://gitforwindows.org/), which also
   provides Git Bash; Workhub reads local changes and diffs with `git`. Install Node.js only if you
   run an agent through `npx` (Codex does). Claude Code needs neither: its binary ships inside the
   app.
2. Download `Workhub-2-<version>-win-x64.exe` and its `.sha256` file from the Releases page.
3. Check the download in PowerShell and compare the result with the `.sha256` file:
   `Get-FileHash .\Workhub-2-<version>-win-x64.exe -Algorithm SHA256`
4. Run the `.exe`. SmartScreen shows "Windows protected your PC": click **More info**, then **Run
   anyway**. This is expected for every unsigned build. The installer lets you pick the folder and
   installs per user, so it needs no administrator rights.
5. Open Workhub 2, then **Help → Setup Check…**. Fix what it flags, and sign in with a Claude
   account from the check.
6. After you install a CLI (`gh`, `kiro-cli`, `opencode`, `gemini`), restart Workhub. Windows keeps
   the `PATH` an app started with, so a running Workhub does not see the new program. See
   [Troubleshooting](../troubleshooting.md#an-agent-is-not-found-on-path).

The **Shell** view opens the shell named by the `COMSPEC` environment variable, else
`powershell.exe`.

## Uninstall

- **Windows**: **Settings → Apps → Installed apps → Workhub 2 → Uninstall**.
- **macOS**: delete **Workhub 2** from `/Applications`.

Uninstalling leaves your data folder in place. To remove it too, delete it by hand:
`%APPDATA%\Workhub 2` on Windows, `~/Library/Application Support/Workhub 2` on macOS. The folder
holds your settings, encrypted secrets and logs. **Settings → General → Storage** shows the exact
path.

## First run

1. Open **Help → Setup Check…** (or **Settings → Profiles**, which has the same entry). It lists
   what Workhub needs on this machine and the optional integrations. Each item shows **Ready**,
   **Needs a look**, **Missing** or **Not set up**, with a button to fix it. Nothing in the check
   changes a setting by itself.
2. The **Welcome…** window (Help menu) walks you through creating a first profile: a name and the
   folders you work in. You can add more later.
3. In **Settings → Agents**, add the agent accounts you use. A Claude account is a config folder;
   Kiro and Codex use their own CLI sign-in. See [Profiles](profiles.md).
4. In **Settings → Profiles**, give the profile folders, a default folder and the accounts it may
   use, and turn on the optional modules you want (Health, Chat watcher, Automations).
5. Optional: connect a code host, a ticket tracker, Slack and Elasticsearch. See
   [Pull requests](pull-requests.md), [Tickets](tickets.md), [Slack](slack.md) and
   [Health](health.md).
6. Start a session with **New session** (⌘/Ctrl+T). See [Sessions](sessions.md).

Secrets you type into Settings (API tokens) are stored encrypted with the operating system keychain
and never written to the settings file. If the system cannot encrypt, Workhub refuses to store
them.

If you used Workhub 1 on macOS, **Settings → General** offers **Import from Workhub 1**. It shows
a **Preview** of what would be added, never changes Workhub 1, and copies no secrets: connections
that need one are marked "re-enter the secret". A separate **Import tokens from Workhub 1** step
can copy Jira and Elastic tokens from the macOS Keychain, with a permission prompt per token.

## Updates

**Settings → General → Updates** has a **Check for updates** switch, off by default: nothing
contacts GitHub unless you turn it on or press **Check now**. On Windows and the Linux AppImage the
app can download and install the new version (**Download and restart**). On macOS an unsigned app
cannot replace itself, so Workhub only announces the new version and opens the release page: download
it and replace the app.

## Menu bar and tray

Closing the window can keep Workhub running in the menu bar (macOS), the notification area
(Windows) or the status area (Linux), so sessions, Slack and automations keep working. Turn this
off in **Settings → General → Menu bar**. The icon opens a small panel with the sessions that need
you, plan usage, pull requests and notifications.

Next: [Profiles](profiles.md).
