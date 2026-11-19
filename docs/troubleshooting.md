# Troubleshooting

## Logs

Workhub keeps an always-on log of the main process.

- **Open it**: **Help → Reveal Logs** shows `main.log` in your file manager, with what is buffered
  written out first.
- **Where it is**: `<dataDir>/logs/main.log`. The data folder is shown in **Settings → Advanced →
  Data**. In a development run it is `packages/app/.dev-data/`, or `WORKHUB_DATA_DIR` when set.
- **Session failures**: a session that fails to start or ends on its own is logged with the last lines
  the agent wrote to stderr (never your prompts). Those lines are redacted first: API keys such as
  `sk-…`, bearer tokens, `key=` and `token=` values and long base64-like blobs become `[redacted]`.
- **Rotation**: when `main.log` reaches 4 MB it is renamed to `main.1.log`, the previous `main.1.log`
  becomes `main.2.log`, and the oldest copy is dropped. Two rotated copies are kept, so the logs
  never take more than about 12 MB. The file is created with owner-only permissions.
- **Format**: one line per entry: an ISO timestamp, a level (`DEBUG`, `INFO`, `WARN`, `ERROR`) and
  a message. Writing the log never throws: if it cannot be written, the line is dropped and the app
  goes on.

### Background jobs

The alert checks (health, tickets, flow maps, metric alerts), pull request events, calendar reminders,
the Slack watcher and the history index catch their errors and try again on the next run. Each one
now logs the **first** failure of a streak (`job <name> failed: <error>`, cut to 300 characters and
redacted) and stays quiet while it keeps failing, then logs `job <name> recovered after <time>, <n>
failed runs`. If notifications stopped, look for a `job ... failed` line without a `recovered` after it.

### Export diagnostics

**Help → Export Diagnostics…**, or **Settings → Advanced → Diagnostics and help → Export**, asks for a
folder and writes a `workhub-diagnostics-<time>` subfolder in it:

- `main.log` and its rotated copies, with credential-looking text masked again;
- `versions.json`: the app, Electron, Node, Chromium and OS versions;
- `jobs.json`: the table of background jobs (last run, last success, last error, failures in a row);
- `database.json`: the database size and whether a backup exists (not its path);
- `config.redacted.json`: your settings with every secret-like value, environment and header map and
  every path replaced by `[redacted]` or `[path]`.

It never includes `secrets.json`, the database, your sessions or your prompts. It is a plain folder
you can read before attaching it to a report.

### What is logged

- A `start` line with the app version, whether it is packaged, platform, architecture and Electron
  version; `ready` and `quit`.
- Uncaught exceptions and unhandled rejections, with the error class, message and the first stack
  frames.
- Event-loop stalls: how long the main process was blocked and the names of the work that ran then.
- IPC calls slower than 300 ms (channel name and timings) and IPC calls that threw (channel name and
  error).
- Errors and long tasks reported by the app's windows, limited to 20 per kind per minute.
- Some background jobs, such as the token spend scan (duration and file count).

### What is not logged

- The arguments or results of IPC calls, which carry prompts, messages and secrets.
- Conversations, prompts and agent replies. Tokens, API keys and similar credential patterns are
  replaced with `[redacted]` in error text, and long messages are cut. This is a best-effort
  filter, so read the log before sharing it.

When you report a problem, include the app version, your OS, the steps to reproduce and the relevant
lines of `main.log`. Report security problems privately as described in [SECURITY.md](../SECURITY.md).

## The database

Workhub keeps its state (open sessions, names, watcher memory, spend, Plan, flow maps and their
history) in `workhub.db`, a SQLite file in the data folder; **Settings → Advanced → Data** shows its
path and size. `config.json` and `secrets.json` stay separate files.

- **Start-up lines**: `main.log` has `database <path> schema=<n>` and the result of the one-time
  import of earlier versions' JSON files (`legacy JSON import: imported …; skipped …; corrupt …`).
- **The old JSON files**: the import runs once per data folder. Nothing is deleted: an imported file
  is renamed to `<name>.json.migrated` (`flow-maps/` and `flow-history/` to `flow-maps.migrated/` and
  `flow-history.migrated/`), one whose data the database already had to `<name>.json.skipped`, and
  one that is not JSON to `<name>.json.corrupt`. Workhub never reads them again; once it starts fine
  and your sessions, Plan and flow maps look right, you can delete them by hand.
- **Going back to an older version**: an older version does not know the database and starts from
  its own JSON files (the `.migrated` ones are not read, so it starts empty). When you return to this
  version, the database is used as it was; whatever the older version wrote is kept as `.skipped`
  files and is not merged.
- **A damaged database**: only when SQLite reports `workhub.db` as damaged does Workhub rename it to
  `workhub.db.corrupt-<timestamp>`, log it, show a notice in **Settings → Advanced** (Diagnostics and
  Data) with that path and the backups folder, and start with a fresh one. While a `.corrupt-*` file
  is there no backup is pruned. Restore the newest copy with **Restore…** (see below).
- **The database cannot be opened** (locked by another process, disk full, no permission): Workhub
  shows an error and quits, and leaves the file as it is. Fix the cause and start again.
- **Backups**: `backups/workhub-YYYY-MM-DD.db` about 30 seconds after start and once a day,
  `workhub-YYYY-MM-DD-HHmm.db` for **Back up now**; the newest 7 of each kind are kept. **Show backups
  folder** in Settings → Advanced → Data opens the folder.
- **Restoring a backup**: Settings → Advanced → Data → **Restore from a backup** lists the copies
  (date, size, automatic or manual) with **Restore…** on each. Workhub first checks the copy: it must
  open, pass `PRAGMA integrity_check` and have a schema no newer than this version's; otherwise it is
  refused and nothing changes. Then Workhub quits (stopping sessions, background jobs and the report
  workers, and closing the database), moves `workhub.db` aside as
  `workhub.db.before-restore-<timestamp>`, copies the backup into place and starts again. The file
  set aside is listed too ("Before a restore"), so a restore can be undone. If the swap fails, the
  original file is put back, an error says why and Workhub starts on it. `main.log` has a
  `restore:` line for each step. Restoring by hand still works: quit Workhub, copy
  `backups/workhub-<date>.db` over `workhub.db` and delete `workhub.db-wal` and `workhub.db-shm`.
- **Flow maps** are no longer read from a `flow-maps/` folder: import them in **Settings → Profiles → (profile) → Screens → Flow maps**
  or post them with the `workhub-flow-map` skill.

## A settings upgrade went wrong

When a new version has to convert `config.json` to a newer format, it keeps the original next to it as
`config.json.v<old>.bak` (for example `config.json.v7.bak`, readable by you only) before the first save
after the upgrade. The data folder is the one **Settings → Advanced → Data** shows. Only the 3 newest
copies are kept, and an existing copy of the same version is never overwritten. To go back, quit
Workhub, copy the `.bak` file over `config.json` (keep the current one aside if you want it), and start
the older version that wrote it; this version converts the file again on its next start.

## Health is unreachable or returns 401

On the Health screen, an environment that cannot be read shows the reason and **Try again**.

| Message | Likely cause and fix |
|---|---|
| "Elasticsearch is unreachable (is the VPN up?)" | The host cannot be reached. Connect the VPN (a cached DNS answer can make the VPN look up while connections still fail), then **Try again**. Check the URL in **Settings → Profiles → (profile) → Screens → Health**. |
| "Elasticsearch refused the credentials (HTTP 401)" (or 403) | The API key or password is wrong, expired or lacks read access. Enter it again in **Settings → Profiles → (profile) → Screens → Health** (leave the field empty only to keep the stored one) and use **Test connection**. Paste the encoded API key, or `id:api_key`; both are accepted. |
| "This URL did not answer as Elasticsearch" or "This URL answered HTTP 404, so it is not the Elasticsearch endpoint" | The address is not the Elasticsearch endpoint. Kibana often redirects `/` to a login page or returns a page that is not cluster info. On Elastic Cloud the host contains `.es.` and the port is `9243`. On Kubernetes the Elasticsearch port is often `9200`. |
| "A credential that cannot see an index is told it does not exist" | The key was accepted. Elasticsearch hides an index the key cannot read behind HTTP 404. Name an index the key can read (for example `logs-apm.error-*`) and grant the key read on it. A test made before any environment is saved only checks the cluster root. |
| "The Elasticsearch certificate was rejected" | The server certificate is not trusted. Use **TLS certificate → Pin one certificate** with the server's SHA-256 fingerprint for a self-signed certificate. **No validation** works but exposes the credentials to anyone on the network path. |
| "The query took longer than 20 s and was dropped" | The cluster is slow or overloaded. Try again later, or raise **Refresh every** so reads are less frequent. |
| A figure "from {time}" | The last read failed, so the screen shows older data. |

A **Blind** environment is not an error: part of the picture (for example Kubernetes metrics) is
missing, and **Blind spots** says what.

## An agent is not found on PATH

New session marks an agent **not installed**, with how to install it, when its command is not on
`PATH`. Then:

1. Install it (for example `kiro-cli`, `opencode`, `gemini`), or let **Help → Setup Check… → Install
   what is missing** install it into Workhub's own tools folder. Codex needs Node.js, because it runs
   through `npx`; Workhub can install its own Node.js and fetch the adapter ahead, else the first
   session downloads it.
2. Make sure it is on the `PATH` of your **login shell**. Apps launched from the Finder or a desktop
   launcher inherit a bare `PATH`, so Workhub reads the one your login shell builds, once at
   startup and again after a Setup install (Windows keeps its `PATH` as is). Sessions, the Setup check,
   `gh`, `glab` and `git` all use that same `PATH`. After changing your shell profile, restart Workhub.
3. If the program lives elsewhere, set **Command** on the agent's account in **Settings → Agents**
   to a full path.
4. Run **Help → Setup Check…** for a list of what is missing.

Claude Code needs no separate install; sign in with a Claude account from the setup check.

## Installing a tool fails

**Install what is missing** and each **Install** button say why an install stopped:

- **Could not reach the download server**: no internet connection, or a firewall blocks
  `nodejs.org`, `github.com`, `gitlab.com` or `registry.npmjs.org`.
- **A proxy blocked the download**: Workhub downloads through the system's proxy settings, as a
  browser does. npm installs (OpenCode, Gemini CLI) use npm's own settings: set `proxy` and
  `https-proxy` in `~/.npmrc` (`%USERPROFILE%\.npmrc` on Windows).
- **The download did not match its published checksum**: the file was thrown away. Try again; if it
  keeps happening, something on the network is changing downloads.
- **A file was in use**: on Windows an antivirus often scans a new file for a few seconds. Workhub
  retries for a moment; if it still fails, wait and press **Try again**. Removing a tool that is
  running fails the same way: close the sessions that use it first.
- **The disk is full**: Node.js takes about 220 MB unpacked, OpenCode about 350 MB.
- **npm could not install it**: npm's last lines are shown below the message.

A failed or canceled install leaves nothing half installed: a download goes to a temporary name in
`tools/.partial` and is only moved into place after it is checked and unpacked. To start over,
remove the tool in **Settings → Advanced → Tools installed by Workhub**, or delete the `tools`
folder inside the data folder while Workhub is closed.

## A Plan calendar fails

On the Plan screen and in **Settings → Profiles → (profile) → Screens → Plan → Calendars**, a calendar that cannot be read shows why.
**Test calendar** runs the same read.

| Message | Likely cause and fix |
|---|---|
| "the address was refused (it may have been reset)" | The calendar service answered 401, 403, 404 or 410. The private address was reset or revoked. Copy the current address from the calendar service and paste it again. |
| "the address does not return a calendar" | The link answered, but not with an `.ics` calendar. Check that you copied the ICS (secret iCal) address, not the page address. |
| "the calendar is too large (over 5 MB)" | Workhub refuses a calendar over 5 MB. Use a smaller calendar. |
| "the calendar could not be reached" | The host did not answer, or the address does not start with `https://` or `webcal://`. Check the network and the address. |
| "no address is stored" | The calendar has no saved address. Paste it again and **Save calendar**. |

Some organizations turn private addresses off. If yours does, the option is missing in the calendar
service or the address is refused, and Workhub cannot read that calendar. See
[Plan](user-guide/plan.md#adding-a-calendar).

## An agent stops as soon as it starts

The session shows the agent's exit code and the last lines it wrote to its error output (stderr):
the cause is usually there, such as a missing sign-in or a package `npx` could not download.
To see the whole output, run the agent's command yourself in the same folder, for example
`npx -y @agentclientprotocol/codex-acp@2.3.0` or `opencode acp`. When it starts fine it waits
silently for input (stop it with Ctrl+C).

## An agent does not finish starting

The session shows which start step the agent never answered (`initialize`, `session/load`,
`session/resume`, `session/new`, or the start-up mode or model switch), after 60 s by default,
and the last lines it wrote to stderr, which also go to `main.log`. When the agent had answered
`initialize`, the message adds what to check. For Codex that is the sandbox, permissions and MCP
servers in `CODEX_HOME/config.toml` (default `~/.codex/config.toml`), and Codex's own logs: a
profile or sandbox setting the agent cannot enforce can make `session/new` hang with nothing on
stderr. For other agents it points to the agent's own configuration. The step name and the hint
are in English.

A slow machine or a big folder may just need more time. Set `startTimeoutMs` (milliseconds) on the
agent in `config.json`; a custom agent can also set `startHint` to the text shown after a hang:

```json
{ "id": "my-agent", "startTimeoutMs": 180000, "startHint": "check my-agent's MCP servers" }
```

## An agent cannot reach Workhub

Agents talk to Workhub through its local control endpoint (Plan, flow maps, review). Every session
gets these environment variables:

- `WORKHUB_SESSION`: the session id.
- `WORKHUB_SESSION_TOKEN`: the session's own token; send `X-Workhub-Token: $WORKHUB_SESSION_TOKEN`.
  Without it only reads of the active profile's plan and automations are answered; changes,
  History and analytics answer `401`.
- macOS and Linux: `WORKHUB_SOCKET`, the path of a Unix socket.
- Windows: `WORKHUB_URL` and `WORKHUB_TOKEN`. The endpoint is a loopback HTTP port with a
  per-launch token; send `Authorization: Bearer $WORKHUB_TOKEN` too.

If calls fail with "no such file", "connection refused" or a rejected token ("unknown or revoked
session token"), the session probably started before Workhub restarted, or was removed, and holds
old values. The socket path, the port and the tokens change on each launch. Start a new session. Also check that the session runs inside Workhub: a
terminal opened outside it has none of these variables.

## Updates

- Update checks are off by default. Turn on **Settings → General → Updates → Check for new versions automatically**, or
  press **Check now**. Updates are only checked in the installed app, not in a development run.
- **Install update** downloads and installs the new version, then asks to **Restart now** or
  **Later** (it starts the next time you open Workhub). On Windows and the Linux AppImage, **Later**
  installs it when the app quits.
- **macOS**: the app replaces its own bundle, as the install script does, after checking the
  download's checksum. When it cannot write to its folder (it is not in Applications, or the folder
  is read-only) it opens the release page instead; download it and replace the app.
- Other Linux installs (the `.deb`) update by installing the new package.
- "Could not check for updates" means GitHub could not be reached or the release has no update
  metadata; check the network.

## macOS says the app cannot be opened

Release builds are signed ad hoc and not notarized, so Gatekeeper blocks the first launch.

1. Open the app once and dismiss the warning.
2. Go to **System Settings → Privacy & Security**, scroll to **Security** and click **Open Anyway**.

Or remove the quarantine flag and open it again:

```sh
xattr -dr com.apple.quarantine "/Applications/Workhub 2.app"
```

Verify the download against its `.sha256` file if you want to be sure it is the published build.

## Windows notes

- SmartScreen shows "Windows protected your PC": click **More info**, then **Run anyway**.
- Quitting with a live Shell session can print `Error: AttachConsole failed` from node-pty's
  `conpty_console_list_agent.js`. It is a harmless race in node-pty's Windows kill path (the shell is
  already gone) and does not affect the app.
- Windows and Linux builds are produced by CI but are still untested on real machines; please
  report what you find.
- Running the tests from source without administrator rights or Developer Mode skips the
  symbolic-link test.

## Other

- **Pull requests say `gh` is not installed or signed out**: install the GitHub CLI and sign in
  (**Sign in** on the GitHub row of **Help → Setup Check…**, or `gh auth login`), then refresh.
  Workhub stores no GitHub token.
- **The setup check says GitHub is not signed in, but `gh` has a token**: GitHub refused that
  token (revoked or expired, or left in the keychain after `gh`'s settings were removed). Press
  **Sign in** again. "Signed in, but GitHub did not answer" means the check got no answer at all:
  checks that ask GitHub or GitLab wait at most 5 seconds, so a slow network or a rate limit
  shows this. Check the network, then check again.
- **A window shows "Something went wrong"**: part of the window failed to draw. Your sessions keep
  running. **Reload window** draws it again and the chats come back; a single session that fails
  shows "This session hit an error" with **Try again**. A window whose process crashes reloads by
  itself, at most 3 times a minute. The error is in the log (**Help → Reveal Logs**).
- **The Slack screen shows "Failing" or nothing**: check that **Watch Slack** is on, that the chosen
  Claude account has the Slack connector, that the channel ids are right and that the hours and days
  include now. Reads also wait when the account is over the usage guard or a ceiling.
- **A secret cannot be saved**: Workhub refuses to store secrets when the operating system cannot
  encrypt them (on Linux that needs libsecret or kwallet).
- **Settings cannot be edited**: the config file failed to load (invalid JSON, a value it does not
  accept, or a file written by a newer version). The app still starts, with no profiles, accounts or
  connections, and a banner at the top of the main window names the problem and the file's path.
  Nothing is saved, so the file is never overwritten, and the sessions of the last run are kept for
  later. Fix the file (or restore a copy), then press **Try again** in the banner.
