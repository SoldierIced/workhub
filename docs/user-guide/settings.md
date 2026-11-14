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

The navigation on the left has six entries in three groups: what holds for the whole app (**This
app**), what each profile has (**Per profile**), and **Advanced**. Everything outside **Profiles**
applies to the whole app; everything inside a profile applies to that profile only. A red dot marks a
section with a problem in the stored settings; the **Fix** buttons at the top open the place that
fixes it (a profile's problem opens that profile on the right tab).

| Group | Section | What it holds |
|---|---|---|
| This app | **General** | **Language and appearance**: language (System, English or Spanish), **Light or dark**, **Terminal colours** (**Change…** opens the searchable list with a preview), **Use these colours in the whole app**, and **Text size** (**Adjust…**: app and conversation text, terminal font and size; kept on this computer). **On open and close**: **Reopen my sessions when Workhub starts** and **When the window closes, keep running in the menu bar** (notification area on Windows, status area on Linux). **Voice**: read replies of new sessions aloud, **Voice and speed** on one row with **Test**, and the **Model to summarize before reading**. **Updates**: **Check for new versions automatically**. |
| | **Notifications and alerts** | What Workhub tells you about, where, and when it stays quiet; the app icon badge and the menu bar panel. |
| | **Agents** | One card per agent installed on this computer, with its own sign-in and its accounts, **Add account** and each account's form; the usage reading switch under each agent. See [Agents](#agents). |
| | **Connections** | The services Workhub reads, grouped by kind (Code, Tickets, Calendars, Slack, Health), each with the profiles and screens that use it. See [Connections](#connections). |
| Per profile | **Profiles** | The list of profiles: colour and symbol, name, an **active** badge and a summary (folders, screens that are on, agents offered), with **Open** and a copy button that duplicates it; **New profile** adds one. See below. |
| Advanced | **Advanced** | **Diagnostics and help** (**Setup check**, **Welcome tour**, **How Workhub works**) and **Data**: where `config.json` and `secrets.json` are kept and, on macOS while Workhub 1 is on this Mac, **Import from Workhub 1**. |

### A profile

**Open** on a profile shows it, with every profile listed under **Profiles** in the navigation (the
open one marked). Editing a profile never changes which profile is active; that is chosen in the
sidebar. Its header holds the name, colour and symbol, and **Delete**. Under it, four tabs:

| Tab | What it holds |
|---|---|
| **Folders** | The profile's folders, the default folder for new sessions, each folder's options, and worktrees ("each new session in its own worktree"). |
| **Screens** | One row per screen with its switch and the connection it reads on the same row: **Pull requests**, **Tickets**, **Slack**, **Automations**, **Health**, **Flow maps** (reads the Health connection), **Plan** and **Review before the pull request**. Opening a row shows that screen's settings for this profile: trackers ([Tickets](tickets.md)), the Slack archive time and the watcher ([Slack](slack.md)), the Elasticsearch connection, environments, alert kinds, metric rules and quiet hours ([Health](health.md)), the maps folder and limits ([Flow maps](flow-maps.md)), calendars, reminders, the brief, people and the inbox ([Plan](plan.md)), and the [review before PR](review-before-pr.md). **None** as the connection turns Pull requests or Tickets off. |
| **Agents** | **Agents this profile offers, in order** (the first one offered is the default), **If a Claude account reaches its limit** (account failover), and which accounts and agents the profile offers. |
| **Sessions and links** | **Open links with**, **Use this profile for folders without one**, and the environment variables of its sessions (values stored encrypted). |

Old links into Settings keep working: a link to a former section (Tickets, Health, Plan, AI review…)
opens the active profile on the **Screens** tab, on that screen's row.

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
accents. Each result shows where it lives (Group › Section › Subgroup, and for a profile's setting
the tab and screen), its label and hint. Enter (or a click) opens the section, scrolls to the
setting and highlights it for a moment; a profile's setting opens the profile that is open (else the
active one) on its tab. The arrow keys move between results. Esc clears the search, and a second Esc closes Settings.

## Where settings live

**Settings → Advanced → Data** shows the folder with `config.json` (settings, never secrets) and
`secrets.json` (tokens, encrypted with the operating system keychain). Workhub makes no network
calls except to services you configure and, if you turn it on, GitHub for update checks. There is no
telemetry. See [SECURITY.md](../../SECURITY.md) for what is stored where.

## Agents

**Settings → Agents** lists the agents installed on this computer and the accounts they sign in
with. Which of them a profile offers, in which order, and the account failover are set in each
profile (see [Profiles](profiles.md#accounts)).

Each agent has a card: its name, whether it is installed, and **Add account** (Kiro keeps one login
per computer, so it offers **Add variant**: the same login with other variables, command, model or
mode). The rows of the card are:

- **Sign-in of this computer · no extra account**: the agent's own login, used by profiles that
  offer the agent without an account. **Edit** shows its state, plan and usage, the default mode of
  its sessions and its usage ceilings.
- One row per account: its initial, name, plan (when the usage reading knows it), sign-in folder and
  where it is offered, for example *offered in Acme web (1st), Side project (2nd)* (its place in
  each profile's agent order). On the right, the most spent window with its ceiling
  (*5 h: 82 % · cap 90*). **Edit** opens the account's form in place.

The account form has **Name** (how it appears in New session: *Claude · Work*), **Sign-in folder**
(**Choose…**; an empty folder is a new login, Workhub runs the agent with `CLAUDE_CONFIG_DIR` or
`CODEX_HOME` pointing at it), the sign-in state, and **Offer in profile**: one switch per profile,
saved with the account. A new account is added at the end of each checked profile's agent list and
is offered there as soon as it is saved; which account goes first is decided in the profile. **More
options** holds **Model and permission mode when starting**, **Stop sending automatic work past
the…** (the 5 h and weekly ceilings of the account, see [Usage and budgets](usage.md#budgets-ceilings)),
and **Environment variables and command** (values go to the secret store). **Delete** removes the
account.

A profile that offers a Claude account no longer offers Claude's bare login. When a new account
would take the bare login away from a profile, the form says so and offers **Create “Personal”
pointing at ~/.claude**, which makes the computer's login an account of its own.

Under the Claude, Codex and Kiro cards, a switch turns their usage reading on (**Show plan usage**,
**Show credits left**). Off, no usage bars or login state are shown for that agent.

**Not installed · How to install them** lists the agents Workhub did not find, with how to install
each. They appear in the list once Workhub finds them in the `PATH`; **Search again** looks again.

### Workhub tools for agents

How agents in your sessions reach Workhub (Plan, automations, history, the review of their changes,
flow maps). Two ways, which can be on together:

- **Give sessions the Workhub MCP server** (on by default): every new session except reviewers
  gets Workhub's MCP server, `workhub`, with tools such as `plan_today`, `inbox_propose`,
  `automation_save` and `history_search`. Claude Code (app and console view, except the console on
  Windows) and the ACP agents (Kiro, Codex, OpenCode) get it. Nothing to install. A session that
  is already open gets it when it starts again.
- **Skills**, per Claude Code folder (one row per Claude account): **Install** copies the
  `workhub-*` skills into `<folder>/skills`, **Update** replaces Workhub's older copies, **Remove**
  deletes them. A folder with the same name that you made yourself shows as **Your own copy** and
  is never touched.
- **MCP outside Workhub**, per Claude Code folder: adds `workhub` to Claude Code's user settings
  (`claude mcp add-json --scope user`), so `claude` in any terminal reaches this Workhub while it is
  open. Not on Windows, where the endpoint's token changes at each launch.

The MCP costs little: Claude Code loads the tool definitions on demand. In a benchmark on the same
tasks (scripts/bench-agent-tools), the MCP took fewer turns, fewer tokens and less time than the
skills; the skills add the rules of when to use each call. See
[architecture](../architecture.md#agent-tools-mcp-and-skills) for the numbers.

## Connections

**Settings → Connections** holds the services Workhub reads. Each is set up once here; each profile
picks which one its screens use. Every connection says who uses it, for example *Used by Acme web ·
Pull requests*. **Edit** opens its form in place, with the fields its service needs; **Edit as text**
shows every option as `key=value` lines for anything the fields do not cover. Secrets go to the
secret store.

| Group | Add | Fields |
|---|---|---|
| **Code** | **Connect GitHub**, **Connect GitLab** | Name, host (empty: the public service), optional token (without one, Workhub reads through the `gh` / `glab` login). **Branches never deleted** (the branches **Close PR** never deletes) is shown once for the whole app. |
| **Tickets** | **Connect Jira**, **Connect Linear** | Name, Jira site and account email, API token or key, project keys and statuses to hide; **Test**. |
| **Calendars** | **Add calendar (ICS)** | Name, your address in the calendar and its private address; **Test**. How often a profile reads its calendars is set in its Plan. |
| **Slack** | | **Watch Slack channels**: the watcher (account and model, interval, hours, channels) and the **Tracking hook** that follows threads from sessions, for the whole app. See [Slack](slack.md). |
| **Health (Elasticsearch)** | **Connect** | URL, authentication (API key or user and password), TLS (system, pinned fingerprint or insecure); **Test**. **Read at most every** (how often any profile may read Elasticsearch) is shown once. |

## Remote access

Pair a phone with this computer and choose what it may do: the relay address, this computer's
name and fingerprint, the QR code to pair, and the paired devices with their capabilities. See
[Remote access](remote-access.md).

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

**Settings → General → Voice** reads each finished reply aloud with a voice installed on your
computer: pick the voice and speed on one row, **Test** them, and choose whether new sessions start
with it. A session's own switch (in
its sidebar menu) overrides the default. Sessions opened by automations, reviews or Slack start with
it off. Stop speaking with ⌘/Ctrl+Alt+. .

**Model to summarize before reading** is the Claude model the chat's **Listen** button summarizes a long agent message
with before reading it (a list of Claude models with **Other…**; empty: **haiku**). Each summary is a small paid query on the session's
Claude account; a small model costs the least. See [Sessions](sessions.md#the-composer).

## Language

The interface is available in English and Spanish. Agents answer in the language you write to them.

## Environment variables (development)

Demo and data-folder variables are listed in the [README](../../README.md#development).
