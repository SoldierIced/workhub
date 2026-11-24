# Getting started

## Requirements

- macOS, Windows or Linux. Only macOS has been tested on real machines so far.
What you need depends on what you want to do; the setup check asks and lists only that as
needed (see [First run](#first-run)).

- The agents you choose (for example `kiro-cli`, `opencode`, `gemini`). Codex runs through `npx`
  and Gemini CLI on Node.js, so they need Node.js; Claude sessions run on the app's own runtime and
  need no Node.js. You do not have to install Node.js yourself: Workhub can download its own copy
  (see [Tools Workhub installs for itself](#tools-workhub-installs-for-itself)). An agent that is
  not installed shows as **not installed** in **New session**, with an **Install** button when
  Workhub can install it for you.
- Claude Code needs no separate install: the Claude Agent SDK and its `claude` binary ship inside
  the app. Sign in with a Claude account from the setup check.
- To work on code: `git`, and `gh` (GitHub) or `glab` (GitLab) signed in, for the code host your
  profile uses.

## Install

Latest version: [Windows (x64)](https://github.com/SoldierIced/workhub/releases/latest/download/Workhub-2-win-x64.exe) ·
[macOS (Apple silicon)](https://github.com/SoldierIced/workhub/releases/latest/download/Workhub-2-mac-arm64.dmg) ·
[Linux AppImage](https://github.com/SoldierIced/workhub/releases/latest/download/Workhub-2-linux-x86_64.AppImage) ·
[Linux .deb](https://github.com/SoldierIced/workhub/releases/latest/download/Workhub-2-linux-amd64.deb)

The quickest way is one line: [Windows](#windows-from-zero) in PowerShell,
[macOS](#macos-in-one-line) in Terminal. It installs the newest published release with no security
prompts; run it again to update.

To install by hand, download the installer for your system from the
[Releases](https://github.com/SoldierIced/workhub/releases) page. Every file has a `.sha256` file
to check the download. The builds are not signed with a paid certificate, so each system asks for
one extra step the first time you open the app.

A release is published as the latest one once its installers are attached. If no
release is published yet, build from source: see the README, [macOS from source](../../README.md#install-by-hand)
and [Build installers](../../README.md#build-installers).

| System | File | First launch |
|---|---|---|
| macOS (Apple Silicon) | `.dmg` or `.zip` | Drag **Workhub 2** to Applications. Gatekeeper blocks the first launch: open the app once, then go to **System Settings → Privacy & Security**, scroll to **Security** and click **Open Anyway**. Or run `xattr -dr com.apple.quarantine "/Applications/Workhub 2.app"`. |
| Windows (x64) | `.exe` installer | SmartScreen shows "Windows protected your PC": click **More info**, then **Run anyway**. The installer lets you pick the folder and installs per user. |
| Linux (x64) | `.AppImage` or `.deb` | `chmod +x Workhub-2-*-linux-x86_64.AppImage && ./Workhub-2-*-linux-x86_64.AppImage`, or `sudo apt install ./Workhub-2-*-linux-amd64.deb`. |

Workhub 2 has its own app id and data folder, so it can run next to Workhub 1.

### Windows from zero

Windows is built by CI and has not been tested on real machines yet. Please report what you find.

1. Nothing else to install first. Workhub can download Node.js, Git (MinGit, without Git Bash),
   the GitHub and GitLab tools, OpenCode and Gemini CLI into its own folder from the setup check
   (**Install what is missing**), with no administrator rights. If you want Git Bash for your
   agents, install [Git for Windows](https://gitforwindows.org/) yourself. Claude Code needs
   nothing: its binary ships inside the app.
2. Open **PowerShell** (Start menu → type `PowerShell`), paste this line and press Enter:

   ```powershell
   irm https://raw.githubusercontent.com/SoldierIced/workhub/main/scripts/install.ps1 | iex
   ```

   It downloads the newest published installer, checks it, installs Workhub 2 for your user (no
   administrator rights, no SmartScreen prompt) and opens it. Run the same line to update.
3. In Workhub 2 open **Help → Setup Check…**, fix what it flags and sign in with a Claude account.
4. A tool Workhub installs itself works at once. After you install a CLI yourself (`gh`,
   `kiro-cli`, `opencode`, `gemini`), restart Workhub: Windows keeps the `PATH` an app started
   with. See [Troubleshooting](../troubleshooting.md#an-agent-is-not-found-on-path).

On Windows, the **Shell** view opens the shell named by the `COMSPEC` environment variable, else
`powershell.exe`.

To run a profile's sessions inside WSL (Ubuntu 22.04 or later), pick the distribution in
**Settings → Profiles → Folders → Where sessions run**. See
[Run sessions inside WSL](profiles.md#run-sessions-inside-wsl).

By hand instead: download `Workhub-2-<version>-win-x64.exe` from the Releases page and run it.
SmartScreen shows "Windows protected your PC": click **More info**, then **Run anyway** (expected
for every unsigned build). To check the download first:
`Get-FileHash .\Workhub-2-<version>-win-x64.exe -Algorithm SHA256`, compared with its `.sha256`.

### macOS in one line

Open **Terminal**, paste this line and press Enter:

```sh
curl -fsSL https://raw.githubusercontent.com/SoldierIced/workhub/main/scripts/install.sh | bash
```

It installs the newest published release to `/Applications` (as **Workhub**, not **Workhub 2**,
the name the `.dmg` uses), with no Gatekeeper prompt, and opens it. A running copy keeps working;
the new version starts the next time you open it.

## Uninstall

- **Windows**: **Settings → Apps → Installed apps → Workhub 2 → Uninstall**.
- **macOS**: delete the app from `/Applications`: **Workhub 2** if you installed the `.dmg` or
  `.zip`, **Workhub** if you used the one-line installer.

Uninstalling leaves your data folder in place. To remove it too, delete it by hand:
`%APPDATA%\Workhub 2` on Windows, `~/Library/Application Support/Workhub 2` on macOS. The folder
holds your settings, encrypted secrets and logs. **Settings → Advanced → Data** shows the exact
path.

## First run

The first time Workhub opens, the **Welcome** window walks you through a first setup, one choice
per screen. Every screen has **Back**; **Finish later** closes the window and keeps what you
already chose. Open it again any time from **Help → Welcome…** or **Settings → Advanced →
Diagnostics and help → Welcome tour**.

1. **What do you want to do?** **Talk with an AI about my files**, **Work on code** (repositories,
   pull requests, tickets) or **Both**. Workhub saves your choice at once; the setup check follows
   it.
2. **Pick your AI.** One card per assistant (Claude, Codex, Kiro, OpenCode, Gemini), each with what
   Workhub found: **Ready**, **Installed, not signed in** or **Not installed**. Claude comes with
   Workhub and needs nothing installed. For another one that is missing, **Install** shows the exact
   command or download and where it comes from, and runs it only after you confirm. **Install what
   is missing** does the same for everything this step needs (and `git` for code), one after
   another. Where the install needs administrator rights, the card shows the command to copy into a
   terminal and says why.
3. **Sign in.** **Sign in** opens the sign-in window (see [Signing in](#signing-in)). The step is
   done when Workhub sees you signed in; it checks again every few seconds and when you come back
   to the window. You can skip it. OpenCode and Gemini ask you to sign in in their first
   conversation instead.
4. **Pick a folder.** The folder the AI works with: your Documents folder when you chose files,
   your home folder otherwise; **Choose another folder…** changes it. Workhub keeps the folder in a
   workspace (a profile: a workspace for one kind of work, with its own conversations), named after
   the folder unless you rename it. A folder that is already in a workspace reuses it.
5. **Connect your code and tickets** (only for **Work on code** and **Both**). Shows whether `git`
   and the GitHub (`gh`) or GitLab (`glab`) tool are installed and signed in, with **Install** (and
   **Install what is missing**) or **Sign in** where they are not, and the ticket trackers (Jira, Linear) with a button to their
   form in Settings. You can skip it.
6. **Ready.** A list of what is set and what is still missing, and **Start a conversation**, which
   opens a new session with the AI you picked in your folder. **Close** ends the welcome without
   one.

Later, **Help → Setup Check…** (or **Settings → Advanced → Diagnostics and help**) shows the same
checks in full. At the top, pick what you want to do (the same choice as the Welcome's first step).
The check lists as **Needed** only what that goal and your choices use:

- the agents your profiles offer or prefer, or that have an account (Claude Code when none is
  chosen), with their sign-in;
- Node.js only when a chosen agent runs on it (Codex, Gemini CLI);
- for code: `git`, and `gh` or `glab` only for the code host a profile uses, and Linear when a
  profile tracks tickets there;
- a profile with folders.

Everything else shows under **Optional**. Each item shows **Ready**, **Needs a look**, **Missing**
or **Not set up**, with a button to fix it. Nothing in the check changes a setting by itself. For a
missing tool the button is **Install** when its official install needs no administrator rights on
your system: Workhub shows the exact command and where it downloads from, runs it on this machine
only after you confirm, then checks again with a fresh search for installed programs. Workhub only
runs commands from its own list of official installers, and checks whether Homebrew or npm are
there before it offers a command that uses them (it never offers Homebrew for `gh` on Linux). Where
the official install needs administrator rights (most Linux packages, `git` on Windows), the row
shows the command to copy into a terminal and a link to the install page. Otherwise the button
opens the install page. A tool that is installed but signed out (Claude, Codex, Kiro, GitHub,
GitLab) has a **Sign in** button.

**Install what is missing**, above the list, installs every needed item that has an **Install**
button, one after another. First it lists what it will download, from where and about how large,
and waits for you to confirm. Each item then shows a line: downloading, checking the download,
unpacking, installing, done, or failed with the reason in plain words and **Try again**. **Cancel**
stops it; an install that was stopped or failed leaves nothing half installed. When the last one
ends, the lines stay on screen with a closing line (everything was installed, or not everything),
and the list is checked again.

### Tools Workhub installs for itself

Where it can, Workhub installs a tool into its own **tools folder** instead of running an install
command: no administrator rights, nothing outside that folder changes, and it works on a computer
with nothing else installed. The folder is `tools` inside the data folder (`%APPDATA%\Workhub 2\tools`
on Windows, `~/Library/Application Support/Workhub 2/tools` on macOS, `~/.config/Workhub 2/tools`
on Linux). Workhub puts it first on the `PATH` of its sessions, terminals, sign-ins and checks.

| Tool | Systems | From | Checked against |
|---|---|---|---|
| Node.js (LTS) | Windows, macOS, Linux | nodejs.org | the published `SHASUMS256.txt` |
| Git (MinGit) | Windows | Git for Windows releases on github.com | the SHA-256 from the release notes |
| GitHub CLI (`gh`) | Windows, macOS, Linux | GitHub CLI releases on github.com | the published checksums file |
| GitLab CLI (`glab`) | Windows, macOS, Linux | GitLab CLI releases on gitlab.com | the published `checksums.txt` |
| OpenCode, Gemini CLI, the Codex CLI | Windows, macOS, Linux | the npm registry, with Workhub's Node.js | npm's integrity check |
| Codex's session adapter | Windows, macOS, Linux | fetched ahead into npm's cache, so the first Codex session does not wait | npm's integrity check |

On macOS and Linux, `git` stays what you have (Homebrew, Apple's tools, your distribution): there is
no official archive to unpack. Claude Code and Kiro keep their official install scripts, which
publish no checksum. The Codex CLI is what signs Codex in: a Codex row with no saved sign-in and no
Codex CLI asks to install it first, then offers **Sign in**. When Workhub's Node.js is missing too,
that one install brings Node.js along. A row's own **Install** shows the same list as **Install what
is missing**: every download, Node.js included when it comes along, with where it comes from. For
large tools the list shows the download and the space they take once installed (OpenCode: about
160 MB to download, about 610 MB installed). Only one install runs at a time: starting another one
meanwhile stops with "Another install is running". **Settings → Advanced → Tools installed by Workhub** lists what
is in the folder, with its version and size, and **Remove** for each one (removing Node.js removes
the agents installed with it).

While something needed is missing, Home shows a small banner that opens the setup check.

Then, as you need them:

- In **Settings → Agents**, add the agent accounts you use. A Claude account is a config folder;
  Kiro and Codex use their own sign-in. See [Profiles](profiles.md).
- In **Settings → Profiles**, open the profile: give it more folders and a default folder on the
  **Folders** tab, the accounts it may use on **Agents**, and turn on the screens you want
  (Health, Slack, Automations…) on **Screens**.
- Connect a code host, a ticket tracker, Slack and Elasticsearch. See
  [Pull requests](pull-requests.md), [Tickets](tickets.md), [Slack](slack.md) and
  [Health](health.md).
- Start more sessions with **New session** (⌘/Ctrl+T). See [Sessions](sessions.md).

## Signing in

The **Sign in** button (in the Welcome, and on the setup check's rows for Claude, Codex, Kiro,
GitHub and GitLab) opens a small sign-in window. It
runs the tool's own sign-in in a terminal inside Workhub, so you do not need a terminal of your
own, and it finds Claude Code even when only Workhub's built-in copy is installed. For a Claude
account, it signs in to that account's config folder.

- When the tool prints a one-time code, the window shows it in large letters with **Copy code**
  and **Open browser**. Open the browser, enter the code and approve. When the tool only prints a
  web address, **Open browser** opens it.
- The window checks every few seconds whether you are signed in, and shows **Signed in** when you
  are; the row you started from (in the Welcome, the setup check or Home) then updates by itself.
  Workhub answers the questions GitHub and GitLab ask before their browser step, with their own
  default (GitHub: let Git use this sign-in; GitLab: its usual registry addresses). If the
  tool asks anything else in the terminal, answer it there.
- For GitLab, Workhub opens the sign-in page in your browser itself and keeps **Open browser** in
  the window, in case the page did not open.
- **Cancel** stops the sign-in; closing the window does the same.

Workhub never asks for or keeps your password or token: you sign in on the tool's own web page,
and the tool stores its sign-in as it always does. Sign-in works for Claude Code, Codex, Kiro, the
GitHub CLI and the GitLab CLI, only from the app on this computer (not from a paired phone).

Secrets you type into Settings (API tokens) are stored encrypted with the operating system keychain
and never written to the settings file. If the system cannot encrypt, Workhub refuses to store
them.

## Updates

**Settings → General → Updates** has a **Check for new versions automatically** switch, off by default: nothing
contacts GitHub unless you turn it on or press **Check now**. On Windows and the Linux AppImage the
app can download and install the new version (**Download and restart**). On macOS the app is unsigned, so it cannot use the system updater;
instead it downloads the release's `.zip`, checks its SHA-256, and swaps its own app in place when it
runs from an app in a folder it can write to (**Download and restart**, as on Windows; the new version
starts on the next launch). From a folder it cannot write to, Workhub only announces the new version
and opens the release page: download it and replace the app.

With **Check for updates** on, Workhub checks when it starts and every 6 hours while it runs. When
it finds a newer version it asks, at most once a day: **Update now** (or **Download the new
version** on a Mac that cannot replace the app), **Later** (asks again the next day) or **Skip this
version** (never asks for that one again; a newer one does). **Check now** in Settings never asks.
**Check for updates…** in the menu bar icon checks at once and opens Settings on this group,
highlighted for a moment, where the result shows.

Both the question and Settings say what changed, so you can decide: for every version after yours,
newest first, a short list of what is **New**, **Improved** and **Fixed**, in the app's language.
Several versions behind, the two newest are open and **Show N earlier versions** opens the rest (up
to 10 versions in all). **See all the changes on GitHub** opens the list of releases, where every
version has its complete list of changes. A release published without notes shows only that link;
when the notes could not be loaded, it says so above the link.

## Menu bar and tray

Closing the window can keep Workhub running in the menu bar (macOS), the notification area
(Windows) or the status area (Linux), so sessions, Slack and automations keep working. Turn this
off in **Settings → General → On open and close**. The icon opens a small panel with the sessions that need
you, plan usage, pull requests and notifications.

Next: [Profiles](profiles.md).
