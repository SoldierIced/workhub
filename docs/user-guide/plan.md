# Plan

Plan shows the meetings of your calendars for today and tomorrow, reminds you before they start,
and can have an agent prepare a short brief for a meeting: who is coming, what you have open with
them, what to ask. It also keeps a list of the people you meet, your **milestones** with their
progress against time, and an **inbox** of things to act on that wait for your approval before they
become tickets.

Nothing in Plan assumes a role or a company. Rules, the brief prompt, people, areas, criticality
levels and where tickets go are yours to set.

## Turning it on

Plan is an optional module, off by default. Turn it on per profile in **Settings → Plan → Plan
module** (or **Settings → Profiles → Modules**). The **Plan** screen (⌘9) then appears in the
navigation and Home gets the **Next meetings**, **Inbox** and **Milestones at risk** cards. The Plan
item in the navigation shows how many inbox items wait for approval.

## Adding a calendar

Workhub reads a calendar from its **private ICS address**: a secret link the calendar service gives
you that returns your events as an `.ics` file. Workhub only reads it; it never writes to your
calendar and needs no sign-in.

> The private address is a secret. Anyone who has it can read your calendar, without signing in.
> Workhub stores it encrypted with the other secrets and never shows it again (the field says
> **Stored**). If it leaks, reset it in your calendar service and paste the new one. Some
> organizations turn private addresses off; if yours does, the option below is missing or the
> address is refused.

Where to find it:

- **Google Calendar** (web): Settings → pick the calendar under **Settings for my calendars** →
  **Integrate calendar** → **Secret address in iCal format**. Use **Reset** there if it leaks.
- **Outlook / Microsoft 365** (web): Settings → Calendar → **Shared calendars** → **Publish a
  calendar** → pick the calendar and **Can view all details** → **Publish** → copy the **ICS** link.
- **iCloud Calendar**: in the Calendar app (or iCloud.com), share the calendar as a **Public
  Calendar** and copy the `webcal://` link. Anyone with the link can read it, as with the others.

Then in **Settings → Plan → Calendars**, **Add calendar**:

- **Name**: how the calendar shows in Workhub.
- **Your address in this calendar** (optional): your email in that calendar. Meetings you declined
  are left out.
- **Private address (ICS)**: `https://…` or `webcal://…` (Workhub reads `webcal://` over https).

**Test calendar** reads the address and says how many events it found and how many are upcoming.
**Save calendar** stores it, and the switch next to each calendar chooses whether the active profile
reads it. A calendar can serve several profiles; a profile can read several calendars, merged into
one agenda. Calendar connections are also listed in **Settings → Connections**.

What Workhub reads: the events from yesterday to two weeks ahead, with their time, title, place,
description, attendees and organizer. Recurring meetings (daily, weekly, monthly, with exceptions
and moved occurrences), all-day events and time zones are handled; cancelled events and attendees
that are rooms are left out. A calendar larger than 5 MB is refused.

**Read again every** (default 15 minutes) sets how often the calendars are read again. **Refresh**
on the Plan screen reads at once (at most every 30 seconds).

## The Plan screen

**Today** lists today's and tomorrow's meetings: the time (or **All day**), the title, how many
attendees, a **Join** button when the event has a video call link (Meet, Zoom, Teams, Webex and
others), and its brief: **Prepare brief**, **Preparing…**, **Brief ready** or **Open brief**.

**Inbox** and **Milestones** are described below; they work without a calendar.

**People** lists the people you added, with their next meeting. Pick one to edit them, see your
meetings with them in the next two weeks, and **Prepare 1:1** (see below).

When a calendar cannot be read, the screen says which one and why (unreachable, address refused or
reset, not a calendar, too large, no address stored) and keeps the events of its last good read.

## Reminders

Every timed meeting gets a notification **Default reminder** minutes before it starts (default 10;
**Off** turns it off). Clicking the notification opens the meeting's call link, or the Plan screen
when there is none. **Settings → General → Other notifications → Meeting reminders** silences them,
and **Pause notifications** applies too.

**Reminder rules** change the reminder of the meetings they match. A rule matches when every
condition you set holds:

- **Title contains any of** (comma-separated words) or **Title matches** (a regular expression),
- **With any of these attendees** (email addresses),
- **At least this many attendees**,
- **Only recurring meetings**.

A matching rule replaces the default reminder for that meeting with its own **Minutes before** (0
means at the start) and, optionally, its own **Message**. Each reminder fires once per meeting,
even across restarts.

## Briefs

A brief is an agent session started for one meeting with the **Brief prompt** filled in for it. You
read the answer in the session like any other. Start one with **Prepare brief** on a meeting, or let
a **Brief rule** start it on its own a number of minutes before matching meetings.

- A meeting gets at most one brief. Asking again opens the session of the first one (reopened if
  you closed it); a brief that failed can be retried.
- A brief runs with the profile's preferred agent in its default folder. A brief rule can name an
  automation in **Run with**: the brief then uses that automation's agent, folder, model, effort and
  permission mode.
- The automations' usage guards apply: a usage ceiling blocks a brief, and a brief started by a
  rule waits while the account's 5-hour usage is over its threshold. A blocked brief shows why and
  can be retried.

The **Brief prompt** (empty means the default) may use these placeholders:

| Placeholder | Filled with |
|---|---|
| `{title}`, `{start}`, `{end}` | The meeting's title and times |
| `{attendees}` | The attendees' names and emails |
| `{description}` | The event description (shortened) |
| `{meetingUrl}` | The call link, if any |
| `{people}` | Your people among the attendees, with their notes |
| `{context}` | Your open pull requests and tickets in progress, and those that involve the people coming |

Workhub never starts a brief by itself unless a brief rule says so.

## People

**Settings → Plan → People** (or the People tab) holds the people you meet:

- **Email addresses** match them to meeting attendees.
- **GitHub user**, **Jira name**, **Linear name** and **Slack handle** find the pull requests and
  tickets that involve them for `{context}`.
- **Notes** go into their briefs: what they own, what to follow up on.

**Prepare 1:1** starts the brief of your next meeting with that person, or, when there is none in the
next two weeks, a general 1:1 brief for today (also kept once per day). The People tab also lists
the open inbox items that involve the person.

## Milestones

A milestone is a named period of work, with a start and an end date (both included), and its
progress, which is either:

- **Typed by hand**: a percentage you update, or
- **Counted from a tracker query**: done tickets over all the tickets the query finds, any status.
  The query uses the profile's tracker, or another tracker connection you pick. It is counted when
  you save the milestone, every 30 minutes, and on **Count again**.

| Tracker | Query |
|---|---|
| Jira | Any JQL, e.g. `project = PAY AND fixVersion = "2.4"` or `labels = launch`. Up to 1000 tickets are counted. |
| Linear | A project name or id (`Checkout revamp`, or `project: Checkout revamp`), or a team key and a label: `team:ENG label:Launch` (quote a label with spaces: `label:"Needs triage"`). |

Each milestone shows its status, a progress bar with a marker at the share of time gone, its dates
and, for a counted one, the counts and when they were read:

| Status | When |
|---|---|
| **Done** | All the work is done (100 %, or every ticket of the query done). |
| **Not started** | Before its start date. |
| **Late** | Past its end date and not done. |
| **At risk** | Progress is behind the share of time gone by more than the margin (default 10 points, **Settings → Plan → Inbox → At-risk margin**), or a counted milestone has started and its query finds no ticket. |
| **On track** | Otherwise. |

The list is ordered by status (late first), then by end date. A failed count keeps the last good
one and says why. Milestones are stored per profile in `planner-state.json` in the data folder, not
in the settings.

## Inbox

The inbox collects things to act on. Every item is a **task**, a **bug** or a **decision**, with a
title, a detail, where it came from, and optionally an area, a criticality, a due date and people.
New items wait in **Pending approval**:

- **Approve** a task or bug creates the issue in the tracker (see the settings below) and links it
  from the item. **Approve** on a decision is **Record**: it goes to **Decisions**.
- **Keep as task** keeps it in Workhub, under **My tasks**: overdue or due today first, then the
  critical and high ones (levels mapped to priority 1 or 2), then the rest. **Done** closes a task
  and **Reopen** brings it back.
- **Discard** closes it.

Nothing becomes a ticket without your approval. Closed items (done, discarded, sent to the tracker)
stay under **Closed this week** for 7 days and are then removed; decisions stay. Filters narrow the
list by kind, area and status, and **Search** finds words in titles and details (handy for
decisions). Select several items to set their area, criticality or due date at once.

Items come from:

- **Add item** on the Inbox tab. An open item with the same title (ignoring case, accents and
  punctuation) is flagged; **Add anyway** adds it all the same.
- **Send to inbox** on a metric alert (**Health → Alerts**, see [Health](health.md#alerts)): a
  pending bug with the alert's details.
- **Agents and automations**, through Workhub's local control endpoint. A session has
  `WORKHUB_SOCKET` and `WORKHUB_SESSION` in its environment:

  ```sh
  curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/inbox \
    -H 'content-type: application/json' \
    -d '{"session":"'"$WORKHUB_SESSION"'","source":"Weekly sync","items":[
          {"kind":"task","title":"Send the rollout plan","detail":"Agreed in the sync",
           "people":["ana@example.com"],"due":"2026-11-05"}]}'
  ```

  The body is `{ "items": [...] }`, a list, or a single item. Each item takes `kind` (`task`,
  `bug` or `decision`; default `task`), `title` (required, at most 300 characters), `detail` (at most
  5000), `people` (names, emails or ids of your People; unknown ones are left out), `due`
  (`YYYY-MM-DD`), and optionally `area`, `criticality` and an http(s) `link`. At most 20 items per
  request. The items go to the profile of `session`, else of `profile` (a profile id), else the
  active one, which must have Plan on. `source` names where they came from, and `"sourceType":
  "meeting"` marks them as meeting follow-ups. Items with the same title as an open one are
  skipped and listed under `duplicates` in the answer. The endpoint only listens on a socket in the
  data folder (a named pipe on Windows) readable by your own user. A brief prompt can ask the agent
  to propose follow-ups this way. See [Agents and the plan](#agents-and-the-plan) for everything
  else an agent can read and change.

**Settings → Plan → Inbox** (saved with the rest of the tab):

- **Areas**: the names you file items under (comma-separated).
- **Criticality levels**: each with a name and the tracker priority it maps to (1 highest or
  urgent, 2 high, 3 medium, 4 low). Empty by default; **Start from four levels** fills a common set
  you can rename.
- **Tracker for new issues** (the profile's tracker by default) and **Project** (Jira project key,
  Linear team key). Approving needs a project.
- **Issue type for tasks** and **for bugs** (Jira only; empty uses `Task` and `Bug`).
- **Issue description**: a template with `{title}`, `{detail}`, `{source}` and `{link}`.
- **At-risk margin** for milestones.

The issue gets the item's title, the description from the template and the priority of its
criticality level. If the tracker refuses (a wrong project or issue type, no permission), the
item stays pending and the error is shown.

## Agents and the plan

An agent running in a Workhub session can read your plan and keep the inbox up to date through the
same local control endpoint, and the `workhub-plan` skill tells it how. Every call names the
session (`session=$WORKHUB_SESSION` in the query, or `"session"` in a body) and acts on that
session's profile; without it, on `profile` (a profile id), else the active profile. When Plan is
off in the profile, the answers are empty and say why.

| Endpoint | Answer |
|---|---|
| `GET /v1/plan/today` | Today's and tomorrow's events: title, start and end (ISO), attendees' names and emails, organizer, call link, a short description, and the brief's phase and session id when one was prepared. With no calendar, `state` and `reason` say why. |
| `GET /v1/inbox` | Items, open ones first. Filters: `status` (`open`, the default, is pending and kept items; or `pending`, `local`, `done`, `discarded`, `ticket`, `all`), `kind`, `area`, `q` (words in the title or detail) and `limit` (50 by default, at most 200). Details are shortened to 1000 characters; `total` counts every match. |
| `POST /v1/inbox` | Proposes pending items (see [Inbox](#inbox)). `added` lists the new ids, `duplicates` the ids of the open items they repeat. |
| `PATCH /v1/inbox/:id` | Changes one item: `status` (`local` keeps it, `done`, `discarded`, `pending` brings a discarded one back), `due` (`YYYY-MM-DD`, or `null` to clear), `area`, `criticality`, and `note`, appended to the detail (at most 2000 characters). Answers with the item. |
| `GET /v1/milestones` | Milestones with their status, progress and share of time gone, and the counts of tracker milestones. |
| `GET /v1/people` | Your people's names, emails and handles, to match attendees. Notes are not shared. |

```sh
curl --unix-socket "$WORKHUB_SOCKET" "http://workhub/v1/inbox?session=$WORKHUB_SESSION&status=local&q=rollout"
curl --unix-socket "$WORKHUB_SOCKET" -X PATCH http://workhub/v1/inbox/<id> \
  -H 'content-type: application/json' \
  -d '{"session":"'"$WORKHUB_SESSION"'","status":"done","note":"Sent in the release thread"}'
```

What an agent cannot do: approve an item. Turning a task or bug into a tracker issue stays your
action on the Inbox tab; an agent only proposes items, keeps, closes, discards or reopens them and
edits their date, area, criticality and detail. A
change an item does not allow (a decision marked done, an item already sent to the tracker) is
refused with the reason. Every change shows up at once in an open Plan screen.

### The `workhub-plan` skill

`skills/workhub-plan/SKILL.md` in the Workhub repository teaches an agent these endpoints and a
few rules: propose items to the inbox instead of creating tickets, offer at the end of a task to
log follow-ups and decisions, mark the local task it finished as done, keep payloads short and
never put secrets in them. Workhub does not install skills by itself: copy the folder into your
agent's skills folder (for Claude Code, `~/.claude/skills/` or a project's `.claude/skills/`), as
with the `workhub-flow-map` skill. It triggers on requests like "what's on today", "my tasks",
"add to my inbox", "log this decision", "milestone status" or "prepare for my next meeting".

## Demo

`WORKHUB_DEMO_CALENDAR=1` replaces every calendar with synthetic meetings, so Plan can be tried
without a real calendar. With `WORKHUB_DEMO_TICKETS=1`, milestone queries return synthetic tickets
and approved inbox items create synthetic issues (kept in memory only). See the [README](../../README.md#development).

### Try it

`npm run demo` starts the dev build with all of this already set up in an isolated data folder
(`.demo-data/`, wipe it with `npm run demo -- --reset`): a "Team lead (demo)" profile with
people, meeting rules, milestones in every status and an inbox with items from meetings. Briefs
do not start by themselves in the demo; **Prepare brief** does start a real agent session.
