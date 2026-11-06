# Settings

Open **Settings** with ⌘/Ctrl+, , the gear at the top right, the menu bar icon, or the app menu on
macOS (**File** elsewhere). Settings opens in a window of its own, which can stay open while you
work in a session: switch between them like any other window. There is one Settings window; opening
it again brings it to the front on the section asked for. Esc or the window's own close control
closes it. Changes show in the main window as soon as they are saved.
Forms use a save bar (**Save**, **Discard**, ⌘/Ctrl+S); moving to another section or closing the
window with unsaved changes asks first.
Each section starts with a one-line description of what it is for.

Fields that take a model or a reasoning effort are a list with the known choices and **Other…**.
Models come from the agent (Claude's aliases `opus`, `sonnet` and `haiku` until it lists its own),
efforts are **Low**, **Medium**, **High**, **Extra high** and **Max**. **Other…** opens a text field
for any other value; a saved value the list does not know shows there, never lost.

The navigation on the left has three groups. A red dot marks a section with a problem in the stored
settings; the **Fix** buttons at the top open that section on the item to fix.

| Group | Section | What it holds |
|---|---|---|
| Workhub | **General** | **Language** (System, English or Spanish), reopening sessions on launch, **Updates**, **Voice** (read aloud) and the Help and setup entries. |
| | **Appearance** | Light, dark or system; the **Terminal color scheme**; terminal font and size; **App text size** and **Conversation text size** (kept on this computer). |
| | **Notifications** | **Show notifications** (the master switch), **Send a test**, the system permission; sessions (Replied, Needs an answer, Error); Slack, Automations, Tickets, Health, Flow maps, meetings and metric alerts; **Pause notifications**; pull request notifications and **Protected branches**; the menu bar icon and the app icon badge; **Menu bar panel** (which blocks the panel shows, macOS and Windows). |
| | **Alerts** | Thresholds and rules for the alerts Workhub raises. |
| | **Agents and accounts** | The accounts first, one card per sign-in with a **Default** badge, **Make default** and **Add account**; then every agent Workhub can run, and the agent order and account failover of the profile being edited. See [Profiles](profiles.md#accounts). |
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

## Profile › Agents

A profile's **Agents** tab (**Profiles**, open a profile, **Agents**) is one list, **Agents this
profile offers, in order**: a row for every account (such as "Claude Code · Personal", with its
config folder and its usage when Workhub has read it) and for every agent that runs with its own
sign-in. Agents and accounts the profile does not offer are listed too, greyed, after the offered
ones ("not offered in this profile").

- The **Offer** switch at the end of a row adds the account or agent to the profile, or takes it
  out. Once a profile offers a Claude account, Claude's own sign-in is no longer a row: the
  profile's Claude sessions always use one of its accounts.
- Drag a row by its ⋮⋮ handle, or use ↑ and ↓, to change the order. The first offered row has the
  **Default** badge: **New session**, opening a session from a pull request or a ticket, and the
  [review before PR](review-before-pr.md) when you picked no reviewer start with it.
- **Account switch** → **If a Claude account reaches its limit**: **Ask me**, **Automatic** or
  **Never**. The session continues with the next Claude account of the list, with the same
  context. With a single Claude account offered there is nothing to switch to, and the choice is
  off.

The order belongs to the profile. With two Claude accounts, **Personal** and **Work**, an "Acme
side project" profile can list Personal first and an "Acme web" profile Work first: each profile's
new sessions start on its own first account, and when that one reaches its limit the session moves
to the other.

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

## Notifications and alerts

**Settings → Notifications and alerts** is the one place that answers "does this notify me, and
when not?".

The first row holds **Notify me** (the master switch: off, Workhub shows no notification at all and
everything stays visible in the app), **Send test** and **Pause…** (1 hour, until tomorrow, or until
you resume; the menu bar icon has the same pause). While paused, the row says until when and offers
**Resume**. If the system does not let Workhub show notifications, the section says so and offers
**Turn on**.

**What notifies you** is a single table with one row per source:

| Column | What it holds |
|---|---|
| **When…** | What happens, in words: "A session finished replying", "A session is waiting for your permission or answer", "A session failed", and so on. |
| **Notify** | The switch of that source. |
| **Threshold** | Set for the whole app: edited in the row. Kept per profile: each profile's value, which opens that profile. "—" when the source has none. |

The rows are grouped:

- **Sessions**: replied (only when you are not looking at the session), waiting for you, failed.
  A session notifies once until you look at it, and its newest notification replaces the older
  one. Sessions of an [automation](automations.md) notify only when they fail unless its
  **Notifications** field says otherwise.
- **Pull requests**: one row with how many events are on ("8 of 10 on"); open it for a switch per
  event (review requested, approved, changes requested, comments, CI failed or passing again,
  conflicts, new commits, merged, closed).
- **Agents**: "An account's usage crosses a threshold", with the thresholds in % (for example
  `80, 95`), saved when the field loses focus. It notifies once per threshold and usage window.
  This is the only place the usage thresholds are edited; ceilings stay with the accounts.
- **Health and metrics**, listing the profiles with Health on: environments that degrade, stop
  answering or recover; services that stop reporting, pods that go down and errors that worsen
  (both rows share one switch); metric alerts ("from High"); flow-map limits ("per map"). Their
  thresholds, minimum severity, business days and map limits are kept per profile, so the table
  shows each profile's value and opens it.
- **Work**: tickets, meetings (each profile's reminder lead time, set in its Plan), Slack and
  automations.

Channels (system notification or menu bar panel) are not a column: the app-wide sources always use
both. Health alerts can still pick their channels per kind, with the Health screen of each profile.

**When not to notify** holds the quiet hours. They hold back Health, metric and flow-map alerts;
sessions and meeting reminders always come through. Quiet hours are kept per profile: with one
profile they are edited right there, with several each profile's hours are listed with a link to
the profile.

**App icon and menu bar** holds the app icon badge, which counts the sessions that need you (Dock
on macOS, taskbar on Windows, launcher on Linux) and goes away as you look at them, and, on macOS
and Windows, what the menu bar panel shows: meetings (and how many), Plan tasks, pull requests,
Health, usage and recent notifications, each a chip that turns on or off.

## Read aloud

**Voice** reads each finished reply aloud with a voice installed on your computer: pick the voice
and speed, **Test voice**, and choose whether new sessions start with it. A session's own switch (in
its sidebar menu) overrides the default. Sessions opened by automations, reviews or Slack start with
it off. Stop speaking with ⌘/Ctrl+Alt+. .

**Summary model** is the Claude model the chat's **Listen** button summarizes a long agent message
with before reading it (a list of Claude models with **Other…**; empty: **haiku**). Each summary is a small paid query on the session's
Claude account; a small model costs the least. See [Sessions](sessions.md#the-composer).

## Language

The interface is available in English and Spanish. Agents answer in the language you write to them.

## Environment variables (development)

Demo and data-folder variables are listed in the [README](../../README.md#development).
