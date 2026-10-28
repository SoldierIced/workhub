# Troubleshooting

## Logs

Workhub keeps an always-on log of the main process.

- **Open it**: **Help → Reveal Logs** shows `main.log` in your file manager, with what is buffered
  written out first.
- **Where it is**: `<dataDir>/logs/main.log`. The data folder is shown in **Settings → General →
  Storage**. In a development run it is `packages/app/.dev-data/`, or `WORKHUB_DATA_DIR` when set.
- **Rotation**: when `main.log` reaches 4 MB it is renamed to `main.1.log`, the previous `main.1.log`
  becomes `main.2.log`, and the oldest copy is dropped. Two rotated copies are kept, so the logs
  never take more than about 12 MB. The file is created with owner-only permissions.
- **Format**: one line per entry: an ISO timestamp, a level (`DEBUG`, `INFO`, `WARN`, `ERROR`) and
  a message. Writing the log never throws: if it cannot be written, the line is dropped and the app
  goes on.

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

## Health is unreachable or returns 401

On the Health screen, an environment that cannot be read shows the reason and **Try again**.

| Message | Likely cause and fix |
|---|---|
| "Elasticsearch is unreachable (is the VPN up?)" | The host cannot be reached. Connect the VPN (a cached DNS answer can make the VPN look up while connections still fail), then **Try again**. Check the URL in **Settings → Health**. |
| "Elasticsearch refused the credentials (HTTP 401)" (or 403) | The API key or password is wrong, expired or lacks read access. Enter it again in **Settings → Health** (leave the field empty only to keep the stored one) and use **Test connection**. |
| "The Elasticsearch certificate was rejected" | The server certificate is not trusted. Use **TLS certificate → Pin one certificate** with the server's SHA-256 fingerprint for a self-signed certificate. **No validation** works but exposes the credentials to anyone on the network path. |
| "The query took longer than 20 s and was dropped" | The cluster is slow or overloaded. Try again later, or raise **Refresh every** so reads are less frequent. |
| A figure "from {time}" | The last read failed, so the screen shows older data. |

A **Blind** environment is not an error: part of the picture (for example Kubernetes metrics) is
missing, and **Blind spots** says what.

## An agent is not found on PATH

New session marks an agent **not installed**, with how to install it, when its command is not on
`PATH`. Then:

1. Install it (for example `kiro-cli`, `opencode`, `gemini`). Codex needs Node.js, because it runs
   through `npx`; its first session downloads the adapter.
2. Make sure it is on the `PATH` of your **login shell**. Apps launched from the Finder or a desktop
   launcher inherit a bare `PATH`, so Workhub reads the one your login shell builds, once at
   startup (Windows keeps its `PATH` as is). After installing a CLI or changing your shell profile,
   restart Workhub.
3. If the program lives elsewhere, set **Command** on the agent's account in **Settings → Agents**
   to a full path.
4. Run **Help → Setup Check…** for a list of what is missing.

Claude Code needs no separate install; sign in with a Claude account from the setup check.

## Updates

- Update checks are off by default. Turn on **Settings → General → Updates → Check for updates**, or
  press **Check now**. Updates are only checked in the installed app, not in a development run.
- **macOS**: an unsigned app cannot replace itself. Workhub announces the new version and opens the
  release page; download it and replace the app in Applications.
- **Windows** and the **Linux AppImage**: **Download and restart** installs the new version. Other
  Linux installs (the `.deb`) update by installing the new package.
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
- Windows and Linux builds are produced by CI but have not been tested on real machines yet; please
  report what you find.
- Running the tests from source without administrator rights or Developer Mode skips the
  symbolic-link test.

## Other

- **Pull requests say `gh` is not installed or signed out**: install the GitHub CLI and run
  `gh auth login`, then refresh. Workhub stores no GitHub token.
- **The Slack screen shows "Failing" or nothing**: check that **Watch Slack** is on, that the chosen
  Claude account has the Slack connector, that the channel ids are right and that the hours and days
  include now. Reads also wait when the account is over the usage guard or a ceiling.
- **A secret cannot be saved**: Workhub refuses to store secrets when the operating system cannot
  encrypt them (on Linux that needs libsecret or kwallet).
- **Settings cannot be edited**: the config file failed to load; the message names the problem, and
  editing stays off until it is fixed.
