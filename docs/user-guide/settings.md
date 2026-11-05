# Settings

Open **Settings** with ⌘/Ctrl+, , the gear at the top right, the menu bar icon, or the app menu on
macOS (**File** elsewhere). Settings opens in a window of its own, which can stay open while you
work in a session: switch between them like any other window. There is one Settings window; opening
it again brings it to the front on the section asked for. The close button at its top right, Esc or
the window's own close button closes it. Changes show in the main window as soon as they are saved.
Forms use a save bar (**Save**, **Discard**, ⌘/Ctrl+S); moving to another section or closing the
window with unsaved changes asks first.
Each section starts with a one-line description of what it is for.

The navigation on the left has three groups. A red dot marks a section with a problem in the stored
settings; the **Fix** buttons at the top open that section on the item to fix.

| Group | Section | What it holds |
|---|---|---|
| Workhub | **General** | **Language** (System, English or Spanish), reopening sessions on launch, **Updates**, **Voice** (read aloud) and the Help and setup entries. |
| | **Appearance** | Light, dark or system; the **Terminal color scheme**; terminal font and size; **App text size** and **Conversation text size** (kept on this computer). |
| | **Notifications** | **Show notifications** (the master switch), **Send a test**, the system permission; sessions (Replied, Needs an answer, Error); Slack, Automations, Tickets, Health, Flow maps, meetings and metric alerts; **Pause notifications**; pull request notifications and **Protected branches**; the menu bar icon and the app icon badge; **Menu bar panel** (which blocks the panel shows, macOS and Windows). |
| | **Alerts** | Thresholds and rules for the alerts Workhub raises. |
| | **Agents and accounts** | Every agent Workhub can run and its sign-ins, the agent order and account failover of the profile being edited, and the accounts. See [Profiles](profiles.md#accounts). |
| | **Usage and budgets** | Usage reading, budgets and alerts. See [Usage and budgets](usage.md). |
| | **Connections** | Code host, chat, Health and calendar connections: kind, provider, endpoint, secret and extra `key=value` options. Each one says which profiles use it. |
| Profile | **Profile and folders** | Name, colour, folders, folder options, worktrees, links, environment variables and the Slack archive time. See [Profiles](profiles.md). |
| | **Modules and screens** | Which optional screens the profile has (Health, Flow maps, Plan, Slack, Automations; Tickets and Pull requests are always on), the connection each one reads with an **Edit** link, and the profile's connections, accounts and agents. |
| | **Tickets** | Jira and Linear. See [Tickets](tickets.md). |
| | **Health** | Elasticsearch connection and environments. See [Health](health.md). |
| | **Flow maps** | The maps folder (one JSON file per map, **Reveal folder**) and importing maps from JSON files. See [Flow maps](flow-maps.md). |
| | **Plan** | Calendars (private ICS addresses, tested and stored as secrets), how often they are read, the default reminder, reminder and brief rules, the brief prompt and people. See [Plan](plan.md). |
| | **Slack** | The watcher, channels and tracking hook (shared by every profile). See [Slack](slack.md). |
| | **AI review** | The [review before PR](review-before-pr.md) settings. |
| Advanced | **Storage and data** | Where `config.json` and `secrets.json` are. |
| | **Import from Workhub 1** | macOS, while Workhub 1 is on this Mac. |

The **Profile** group starts on the active profile. Its picker edits any other profile, or a new
one, without changing the app's active profile; the sections of a module that is off for that
profile say so and link to **Modules and screens**.

## Search

Type in the box at the top of the navigation, or press ⌘/Ctrl+F while Settings is open. Every
setting's label, hint and help text is searched in the current language, without regard to case or
accents. Each result shows where it lives (Group › Section › Subgroup), its label and hint. Enter (or
a click) opens the section, scrolls to the setting and highlights it for a moment; the arrow keys
move between results. Esc clears the search, and a second Esc closes Settings.

## Where settings live

**Settings → Storage and data** shows the folder with `config.json` (settings, never secrets) and
`secrets.json` (tokens, encrypted with the operating system keychain). Workhub makes no network
calls except to services you configure and, if you turn it on, GitHub for update checks. There is no
telemetry. See [SECURITY.md](../../SECURITY.md) for what is stored where.

## Notifications

Notifications are shown by your operating system when a session you are not looking at replies, asks
something or fails. Each one quotes the start of the reply, the question or the error. A session
notifies once until you look at it (more turns meanwhile do not add notifications; an error or a
question after a reply still does), and its newest notification replaces the older one. Sessions of an [automation](automations.md) notify
only when they fail unless its **Notifications** field says otherwise. **Show notifications** is the master switch; it silences every notification
below it. **Pause notifications** (here or in the menu bar icon) silences all of them for 1 hour or
until tomorrow; the menu bar icon can also mute them until you resume. If the system does not let Workhub show notifications, Settings says so and offers
**Turn on**. The app icon badge counts the sessions that need you (Dock on macOS, taskbar on Windows,
launcher on Linux) and goes away as you look at them.

## Read aloud

**Voice** reads each finished reply aloud with a voice installed on your computer: pick the voice
and speed, **Test voice**, and choose whether new sessions start with it. A session's own switch (in
its sidebar menu) overrides the default. Sessions opened by automations, reviews or Slack start with
it off. Stop speaking with ⌘/Ctrl+Alt+. .

**Summary model** is the Claude model the chat's **Listen** button summarizes a long agent message
with before reading it (empty: **haiku**). Each summary is a small paid query on the session's
Claude account; a small model costs the least. See [Sessions](sessions.md#the-composer).

## Language

The interface is available in English and Spanish. Agents answer in the language you write to them.

## Environment variables (development)

Demo and data-folder variables are listed in the [README](../../README.md#development).
