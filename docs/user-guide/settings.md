# Settings

Open **Settings** with ⌘/Ctrl+, (or the app menu on macOS, **File** elsewhere). Forms use a save bar
(**Save**, **Discard**). Each tab starts with a one-line description of what it is for.

| Tab | What it holds |
|---|---|
| **General** | **Language** (System, English or Spanish); **Sessions** (reopen sessions on launch); **Session notifications** (Replied, Needs an answer, Error); **Other notifications** (Slack, Automations, Tickets, Health, **Pause notifications**); **Voice**; **Menu bar**; app icon badge; **Updates**; **Pull request notifications** and **Protected branches**; **Storage**; **Import from Workhub 1** (macOS). |
| **Appearance** | Light, dark or system; the **Terminal color scheme** (a catalog of schemes, optionally applied across the whole app); terminal font and size; **App text size** and **Conversation text size**. Text sizes are kept on this computer, not in the shared settings. |
| **Profiles** | Profiles and their folders, accounts, connections, modules, AI review, links and environment. See [Profiles](profiles.md). Also the Help and setup entries. |
| **Connections** | Code host, chat and Health connections: kind, provider, endpoint, secret and extra `key=value` options. Each profile picks at most one of each kind. |
| **Trackers** | Jira and Linear. See [Tickets](tickets.md). |
| **Health** | Elasticsearch connection and environments. See [Health](health.md). |
| **Slack** | The watcher, channels and tracking hook. See [Slack](slack.md). |
| **Agents** | Every agent Workhub can run, its accounts, the agent order and failover. See [Profiles](profiles.md#accounts). |
| **Usage** | Usage reading, budgets and alerts. See [Usage and budgets](usage.md). |

## Where settings live

**Settings → General → Storage** shows the folder with `config.json` (settings, never secrets) and
`secrets.json` (tokens, encrypted with the operating system keychain). Workhub makes no network
calls except to services you configure and, if you turn it on, GitHub for update checks. There is no
telemetry. See [SECURITY.md](../../SECURITY.md) for what is stored where.

## Notifications

Notifications are shown by your operating system when a session you are not looking at replies, asks
something or fails. **Show notifications** is the master switch; it silences every notification
below it. **Pause notifications** (here or in the menu bar icon) silences all of them for 1 hour or
until tomorrow. If the system does not let Workhub show notifications, Settings says so and offers
**Turn on**. The app icon badge counts the sessions that need you (Dock on macOS, taskbar on Windows,
launcher on Linux) and goes away as you look at them.

## Read aloud

**Voice** reads each finished reply aloud with a voice installed on your computer: pick the voice
and speed, **Test voice**, and choose whether new sessions start with it. A session's own switch (in
its sidebar menu) overrides the default. Sessions opened by automations, reviews or Slack start with
it off. Stop speaking with ⌘/Ctrl+Alt+. .

## Language

The interface is available in English and Spanish. Agents answer in the language you write to them.

## Environment variables (development)

Demo and data-folder variables are listed in the [README](../../README.md#development).
