# Plan

Plan shows the meetings of your calendars for today and tomorrow, reminds you before they start,
and can have an agent prepare a short brief for a meeting: who is coming, what you have open with
them, what to ask. It also keeps a list of the people you meet, your **milestones** with their
progress against time, and an **inbox** of things to act on that wait for your approval before they
become tickets.

Nothing in Plan assumes a role or a company. Rules, the brief prompt, people, areas, criticality
levels and where tickets go are yours to set.

## Turning it on

Plan is an optional module, off by default. Turn it on per profile with the **Plan** switch in
**Settings → Profiles → (profile) → Screens**. The **Plan** screen (⌘9) then appears in the
navigation and Home gets the **Next meetings**, **Inbox** and **Milestones at risk** cards. The Plan
item in the navigation shows how many inbox items wait under **To review**.

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

Then in **Settings → Profiles → (profile) → Screens → Plan → Calendars**, **Add calendar**:

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
that are rooms are left out. A calendar larger than 20 MB is refused. The read waits up to 60 seconds.

**Read again every** (default 15 minutes) sets how often the calendars are read again. **Refresh**
on the Plan screen reads at once (the calendars at most every 30 seconds). It is there even
without a calendar: it also reads the inbox and the milestones again. Changes an agent makes show up
on their own; Refresh is the manual fallback.

## The Plan screen

**Today** lists today's and tomorrow's meetings: the time (or **All day**), the title, how many
attendees, a **Join** button when the event has a video call link (Meet, Zoom, Teams, Webex and
others), and its brief: **Prepare brief**, **Preparing…**, **Brief ready** or **Open brief**.

**Inbox**, **Tasks** and **Milestones** are described below; they work without a calendar. The
Inbox is where things arrive and you decide what they are; Tasks is the work you took on, grouped
by the milestone it moves forward; Milestones are the goals that work counts toward.

### Item details

Click the title of an inbox item or a milestone to open its details in a window of its own; the
Plan screen stays as it was. Each item has one window: clicking its title again brings that window
to the front. The window updates on its own when you, another window or an agent changes the item.

The details show:

- For an inbox item: its kind, status, source, area, criticality, due date, people and its tracker
  ticket (created on approval, or linked by you) with the ticket's state. A local task or bug
  without a ticket shows **Link ticket** (see [Tasks and tickets](#tasks-and-tickets)). For a
  milestone: its status, dates, progress against the time gone, how it is counted and the latest
  ticket counts, or its pieces with their state, weight and share.
- The **detail** of an item or the **notes** of a milestone as Markdown: headings, lists, tables,
  `code`, **bold** and links. Raw HTML is not rendered and images show as text.
- **Links**: the item's link and up to 20 labelled links (a doc, a dashboard, a pull request).
  Links open in the profile's browser. Only `http://` and `https://` addresses are accepted.
- **History**: when it was created, when it was last changed and whether you or an agent changed
  it, and when it closed.

**Edit** changes what is yours to change: for an item its kind, title, detail, area, criticality,
due date, people and links; for a milestone everything its form has, links included. A milestone
you edit here is saved at once, whatever **Milestone changes by agents** says (that setting only
applies to agents). If the item changes while you edit it, the form says so; saving keeps your
version. Saving or **Cancel** (or **Esc**) goes back to the details.

**People** answers "what do I have to talk about with this person, and when". The list on the left
(with **Search people** and **+** to add someone) shows each person's initials, their next meeting
and, as a number, their open topics. Pick one to see, on the right:

- A header with their next meeting (and **in N min** when it starts within the hour), their open
  topics and how many meetings you have together in the next 7 days, then **Join** (the next
  meeting's call link, when it has one) and **Prepare 1:1** (see below). The **⋯** menu holds
  **Edit details** and **Remove** (which asks first).
- **To talk about**: the open inbox items that involve them. Tick one to mark it done (a local task
  or one that follows a ticket; a pending item is decided on the Inbox tab first, and a recorded
  decision stays open until it is discarded). Click a title to open the item. **Add topic** adds an
  item with the person already picked.
- **Meetings together**: your meetings with them in the next 7 days, one per row. The icon at the
  end of a row starts or opens its brief; the meeting about to start says **in N min** instead.

When a calendar cannot be read, the screen says which one and why (unreachable, address refused or
reset, not a calendar, too large, no address stored) and keeps the events of its last good read.

## Reminders

Every timed meeting gets a notification **Default reminder** minutes before it starts (default 10;
**Off** turns it off). Clicking the notification opens the meeting's call link, or the Plan screen
when there is none. **Settings → Notifications and alerts** (Work, meetings) silences them,
and **Pause notifications** applies too.

When a calendar cannot be read (for example right after the laptop wakes, before the network is up),
Workhub retries within seconds, waiting longer after each failure up to five minutes, and reads again
a few seconds after the system resumes. Reminders and the tray agenda keep using the last good events
meanwhile; the Plan screen still shows the error.

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
  permission mode. An automation that is off is ignored: the brief runs with the profile's agent
  instead, so an agent's edit of that automation takes effect only after you turn it on again.
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

The meeting's title, attendees, call link and description are written by whoever sent the invite,
and the pull request and ticket titles in `{context}` by whoever opened them.
Workhub puts each of them in a quoted block, after a first sentence in the prompt that says they are
untrusted content to read and never instructions to follow, and it cuts long values and any text that
would close the block. The rest of your prompt is sent as you wrote it.

Workhub never starts a brief by itself unless a brief rule says so.

## People

**Settings → Profiles → (profile) → Screens → Plan → People** (or the People tab) holds the people you meet:

- **Email addresses** match them to meeting attendees.
- **GitHub user**, **Jira name**, **Linear name** and **Slack handle** find the pull requests and
  tickets that involve them for `{context}`.
- **Notes** go into their briefs: what they own, what to follow up on.

**Prepare 1:1** starts the brief of your next meeting with that person, or, when there is none in the
next two weeks, a general 1:1 brief for today (also kept once per day). The People tab also lists
the open inbox items that involve the person, under **To talk about**.

## Milestones

A milestone is a named period of work, with a start and an end date (both included), and its
progress, which is either:

- **Typed by hand**: a percentage you update,
- **Counted from a tracker query**: done tickets over all the tickets the query finds, any status.
  The query uses the profile's tracker, or another tracker connection you pick. It is counted when
  you save the milestone, every 30 minutes, and on **Count again**, or
- **Made of pieces**: a list of tickets, local tasks and links, each with a weight (see
  [Pieces](#pieces)).

You can switch a milestone from one kind to another in its form; the pieces you added stay in the
form while you try another kind, and are saved only with **Made of pieces**.

| Tracker | Query |
|---|---|
| Jira | Any JQL, e.g. `project = PAY AND fixVersion = "2.4"` or `labels = launch`. Up to 1000 tickets are counted. |
| Linear | A project name or id (`Checkout revamp`, or `project: Checkout revamp`), or a team key and a label: `team:ENG label:Launch` (quote a label with spaces: `label:"Needs triage"`). |

Each milestone shows its status, a progress bar with a marker at the share of time gone, its dates
and, for a counted one, the counts and when they were read:

| Status | When |
|---|---|
| **Done** | All the work is done (100 %, every ticket of the query done, or every piece done). |
| **Not started** | Before its start date. |
| **Late** | Past its end date and not done. |
| **At risk** | Progress is behind the share of time gone by more than the margin (default 10 points, **Settings → Profiles → (profile) → Screens → Plan → Inbox → At-risk margin**), or a counted milestone has started and its query finds no ticket, or a milestone made of pieces has started with no pieces. |
| **On track** | Otherwise. |

### Why a counted milestone is behind

A milestone counted from a tracker query keeps its open tickets. When it is **Late** or **At risk**,
the line under the counts says why, for example "9 open · 4 with no owner · 5 not updated in 7 days
· 4 added after the start". Only the numbers that are not zero appear. A milestone with any other
status shows no such line, only a control that says how many are open (for example "5 open
tickets"); one with no open ticket shows nothing. The control (**Show open tickets** on a late or
at-risk milestone) opens the list under it, and clicking it again closes it; it starts hidden. The
milestone's own window always shows the list, and the line only when the milestone is Late or At
risk.

Each open ticket shows its key and title (click it to open the ticket in the tracker), its status,
who has it ("No owner" when nobody does; nothing when the tracker does not say; on GitHub it is the
person's login, not a display name), when it was last updated, and a badge for each thing that looks wrong:

- **No owner**: nobody has the ticket.
- **No movement**: not updated for more than 7 days, worked out when you look, from the same clock
  as "updated ... ago" (so it stays right when the tracker cannot be reached for days). The number
  in the line counts the tickets the list shows the same way; the ones it leaves out keep what the
  count said.
- **Added after the start**: created after the milestone's start date.

The list shows at most 50 tickets, the most worrying first (the most badges, then the longest
without an update); a last line says how many more open tickets there are, with a **See them all in
the tracker** link that opens the query in the tracker's own search (Jira, GitHub; Linear shows no
link because its addresses need the workspace name, which Workhub does not know). On GitHub the
link is given only when at most 5 repositories are in scope and Workhub could read them; with more,
or when reading them fails, there is no link, because a search of other repositories would show
other results than the count. The numbers in the line
always count every open ticket. They come with the count, so they are as fresh as "counted ... ago"
says, and a milestone counted before this existed shows them after its next count.

**Add milestone** opens the form of a new milestone in a window; saving creates it and closes the
window, **Cancel** (or **Esc**) closes it without saving. The pencil on a milestone opens its window
in the edit form (or switches the window already open to it); saving goes back to its details. The
trash asks before it deletes the milestone.

**Move to profile** in a milestone's window moves it to another profile with Plan on. Its tasks (and
the items that follow one of its tickets) go with it; a task another milestone of the first profile
also uses is copied, and the original stays. Its counts and pending agent proposals go too. Tickets
and queries that read from the first profile's tracker keep reading from it when the other profile
has a different one. The dialog says what goes before you confirm, and the milestone then opens in
its new profile.

The list is ordered by status (late first), then by end date. A failed count keeps the last good
one and says why. Milestones are stored per profile in the database (`workhub.db`) in the data folder, not
in the settings. A counted or pieces milestone shows 100 % only when it is done.

### Pieces

A milestone made of pieces lists what it takes to finish it. A piece is one of:

| Piece | Done when | Its state |
|---|---|---|
| **Ticket** (by key, e.g. `ABC-12`) | The tracker puts it in a done status. | To do, In progress or Done, read from the tracker; **Unknown** until it is read, when the tracker does not know the key, or when the tracker cannot read tickets by key. An unknown ticket never counts as done. |
| **Local task** (an inbox task or bug) | The item is **Done**. | Its inbox status: To review, Kept in Workhub, In the tracker, Done or Discarded. A discarded task is not done. |
| **Link** (any web page) | You tick its box. | Done or To do. |

Each piece has a **weight** from 1 to 10 (5 by default). Progress is the weight of the done pieces
over the weight of all of them, and each piece shows its **share** of the milestone. For example,
with a ticket of weight 2 and a link of weight 8, the link is 80 % of the milestone: ticking it
alone makes the milestone 80 % done. With weights 3, 5, 4 and 2 (14 in all) and the pieces of
weight 3 and 2 done, progress is 5 / 14 = 36 %. A milestone has at most 100 pieces.

In the milestone's form, pick **Made of pieces** and:

- **Add ticket**: type its key (letters, a dash and a number; it is upper-cased) and, when the
  profile has more than one tracker, pick which. The form reads its title from the tracker; a key
  the tracker does not know is added all the same and stays unknown.
- **Add local task**: search your open tasks and bugs (to review or kept in Workhub) and pick one.
- **Add link**: an `http(s)` address and an optional label.
- Set each piece's **weight**; the trash removes a piece from the form (nothing is saved until
  **Save milestone**).

Tickets are read from the tracker when you save the milestone, every 30 minutes and on **Count
again**, all the keys of one tracker in a single request (Jira: a `key in (…)` search; Linear: one
filtered query). A failed read keeps the last good state and says why. A local task's state
changes at once. The Milestones tab shows each milestone's first pieces (kind, key or title,
state and share); its window lists them all, with their weight, when they were read, and the link
boxes to tick. A task you finished stays in the inbox while a milestone is made of it, so its
progress does not drop after the week **Closed this week** keeps items.

## Inbox

The inbox collects things to act on. Every item is a **task**, a **bug** or a **decision**, with a
title, a detail, where it came from, and optionally an area, a criticality, a due date and people.
The Inbox tab shows only the items that wait in **To review**, one at a time: the list of pending
items on the left (kind, due date, criticality, title, source and people), the selected one in full
on the right (where it came from and when, its whole detail and links, area, criticality, people,
due date and milestone), and at the bottom of the right pane the bar **What is it?** with the
decisions. The pencil opens the item's edit form and the arrow opens it in a window of its own.
Number keys take the decisions (**1** Create ticket or Record, **2** Local task, **3** Discard) and
**↑** and **↓** move through the list, while the focus is not in a text field. After a decision the
next item is selected; once you keep or send one, it moves to the **Tasks** tab:

- **Create ticket** (a task or bug) asks first, naming the project, then creates the issue in the
  tracker (see the settings below) and links it from the item, which moves to the **Tasks** tab (see
  [Tasks and tickets](#tasks-and-tickets)). On a decision it is **Record**: it goes to **Decisions**.
- **Local task** keeps it in Workhub, on the **Tasks** tab. **Done** closes a task and **Reopen**
  brings it back.
- **Discard** (the ✕ button) closes it, after you confirm. A discarded item stays under **Closed
  this week**, where **Reopen** brings it back.

Every task and bug shows the milestones it counts toward as chips (click one to open the
milestone). **Pick a milestone** (in the Inbox's **Milestone** field; **No milestone** on the Tasks
tab), or **Change milestone**, opens a menu of the active milestones: tick
one to add the item as one of its pieces (weight 5, change it in the milestone's form), untick it
to take it out. Only milestones made of pieces take items; one whose progress is typed by hand or
counted from a query is listed but cannot be picked, so its progress is never changed by surprise.
An item belongs to a milestone that lists it as a task piece or lists its ticket as a ticket piece.

Nothing becomes a ticket without your approval. Filters narrow the list by kind and area, and
**Search** finds words in titles and details. The line under the list says how many tasks are in
progress and opens the **Tasks** tab. To edit several pending items at once, tick the checkbox that
shows when you point at a row (see the bulk edit below).

### Tasks

The **Tasks** tab shows the work you took on: local tasks and bugs, and those that follow a ticket.
They are grouped by the milestone they count toward: each group shows the milestone's status,
progress against time and end date, and its open tasks (overdue or due today first, then the
critical and high ones, then the rest, then those that follow a ticket). A task in two milestones
shows in both. When items of a milestone still wait in the Inbox, the group says how many. Tasks in
no milestone come next, under **In no milestone**; add them to one from their milestone chip.

Below them are **Decisions** and **Closed this week**: closed items (done or discarded) stay there
for 7 days and are then removed; decisions stay. The same filters and the bulk edit work here.

Select several items with their checkboxes to edit them at once. A bar titled **Edit N selected
items** shows one labelled control per field, each starting on **Don't change**:

- **Area**: an area to set, or **Clear area**.
- **Criticality**: a level to set, or **Clear criticality**.
- **Due date**: **Set a date** (then pick it in **New due date**) or **Clear due date**.

**Apply** stays off until the choice would change at least one selected item, and then says how
many (**Apply to 3 items**). **Clear selection** drops the selection and the choices. The bulk edit
never discards or closes items.

Items come from:

- **Add item** on the Inbox tab. An open item with the same title (ignoring case, accents and
  punctuation) is flagged; **Add anyway** adds it all the same.
- **Send to inbox** on a metric alert (**Health → Alerts**, see [Health](health.md#alerts)): a
  pending bug with the alert's details.
- **Agents and automations**, through Workhub's local control endpoint. A session has
  `WORKHUB_SESSION`, its own token `WORKHUB_SESSION_TOKEN` and `WORKHUB_SOCKET` in its environment
  (on Windows `WORKHUB_URL` and `WORKHUB_TOKEN` instead of the socket; see
  [Agents and the plan](#agents-and-the-plan)):

  ```sh
  curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/inbox \
    -H "X-Workhub-Token: $WORKHUB_SESSION_TOKEN" -H 'content-type: application/json' \
    -d '{"session":"'"$WORKHUB_SESSION"'","source":"Weekly sync","items":[
          {"kind":"task","title":"Send the rollout plan","detail":"Agreed in the sync",
           "people":["ana@example.com"],"due":"2026-11-05"}]}'
  ```

  The body is `{ "items": [...] }`, a list, or a single item. Each item takes `kind` (`task`,
  `bug` or `decision`; default `task`), `title` (required, at most 300 characters), `detail` (at most
  5000), `people` (names, emails or ids of your People; unknown ones are left out), `due`
  (`YYYY-MM-DD`), and optionally `area`, `criticality`, an http(s) `link` and `links`, a list of up
  to 20 `{ "label": "…", "url": "https://…" }` (a bare address works too; the label is at most 200
  characters). The detail may use Markdown. At most 20 items per
  request. The items go to the profile of the session whose token sent them (a session without a
  profile: the profile whose folders hold `cwd`, the folder the agent works in, else the active
  one), which must have Plan on. A proposal without a session token is refused. `source` names where they came from, and `"sourceType":
  "meeting"` marks them as meeting follow-ups. Items with the same title as an open one are
  skipped and listed under `duplicates` in the answer. The endpoint only listens on a socket in the
  data folder readable by your own user (on Windows a loopback port with a token made at each
  launch). A brief prompt can ask the agent
  to propose follow-ups this way. See [Agents and the plan](#agents-and-the-plan) for everything
  else an agent can read and change.

**Settings → Profiles → (profile) → Screens → Plan → Inbox** (saved with the rest of the tab):

- **Areas**: the names you file items under (comma-separated).
- **Criticality levels**: each with a name and the tracker priority it maps to (1 highest or
  urgent, 2 high, 3 medium, 4 low). Empty by default; **Start from four levels** fills a common set
  you can rename.
- **Tracker for new issues** (the profile's tracker by default) and **Project** (Jira project key,
  Linear team key). **Create ticket** needs a project.
- **Issue type for tasks** and **for bugs** (Jira only; empty uses `Task` and `Bug`).
- **Issue description**: a template with `{title}`, `{detail}`, `{source}` and `{link}`.
- **At-risk margin** for milestones.
- **Milestone changes by agents**: **Ask me first** (default) keeps every milestone an agent
  creates, changes or deletes as a proposal; **Apply at once** applies it without asking.

The issue gets the item's title, the description from the template and the priority of its
criticality level. If the tracker refuses (a wrong project or issue type, no permission), the
item stays pending and the error is shown.

### Tasks and tickets

A task or bug can follow a ticket in the tracker:

- **Create ticket** creates one and links it to the item.
- **Link ticket**, in the window of a task or bug kept in Workhub, links an existing ticket by key
  (it never creates one). **Unlink** next to the ticket removes the link; an item created with
  **Create ticket** and then unlinked becomes a plain local task.

While it follows a ticket, the item shows on the **Tasks** tab with the ticket's
state, read with the milestones (when you link it, every 30 minutes and on **Count again** on the
Milestones tab), from the inbox's tracker (**Tracker for new issues**). When the tracker says the
ticket is done, the item is marked **Done** on its own; its history says it was marked done from
the tracker. That happens once: if you reopen the item while its ticket is still done, it stays
open. Linking a ticket that is already done marks the task done at once. **Done** closes an item
in the tracker group by hand, for a tracker that cannot be read.

Items sent to the tracker before this version keep their ticket and show in the same group; the
first read marks those whose ticket is done as **Done**.

## Agents and the plan

An agent running in a Workhub session can read your plan and keep the inbox up to date through the
same local control endpoint, and the `workhub-plan` skill (or Workhub's MCP tools) tells it how.

Every session gets its own token, `WORKHUB_SESSION_TOKEN`, made when the session starts and
dropped when you remove the session. Every call sends it as `X-Workhub-Token`, and the call acts as
that session and on that session's profile only (a session without a profile: the profile whose
folders hold `cwd`, the folder the agent works in, else the active profile). A call that names
another session (`session=` in the query or `"session"` in a body) is refused with `403`; naming a
`profile` does not move it to another one. A reviewer session can read but never change anything.
The token of a removed session is refused with `401`.

Without a token (a `curl` you type in your own terminal), Workhub answers only reads of the active
profile's plan (`GET` of `/v1/plan/today`, `/v1/inbox`, `/v1/milestones` and `/v1/people`, without
`session`, `profile` or `cwd`) and notes it in the log; every change answers `401`. When Plan is
off in the profile, the answers are empty and say why.

| Endpoint | Answer |
|---|---|
| `GET /v1/plan/today` | Today's and tomorrow's events: title, start and end (ISO), attendees' names and emails, organizer, call link, a short description, and the brief's phase and session id when one was prepared. With no calendar, `state` and `reason` say why. |
| `GET /v1/inbox` | Items, open ones first. Filters: `status` (`open`, the default, is pending and kept items and items in the tracker; or `pending`, `local`, `done`, `discarded`, `ticket`, `all`), `kind`, `area`, `q` (words in the title or detail) and `limit` (50 by default, at most 200). Details are shortened to 1000 characters; `total` counts every match. An item's `ticket` has its key and its last known `state` (`todo`, `inProgress`, `done` or `unknown`), with the tracker's `status`, `title`, `url` and `checkedAt` once read. |
| `POST /v1/inbox` | Proposes pending items (see [Inbox](#inbox)). `added` lists the new ids, `duplicates` the ids of the open items they repeat. |
| `PATCH /v1/inbox/:id` | Changes one item: `status` (`local` keeps it, `done`, `discarded`, `pending` brings a discarded one back), `due` (`YYYY-MM-DD`, or `null` to clear), `area`, `criticality`, `note`, appended to the detail (at most 2000 characters), `links`, which replaces the item's links (`null` clears them), and `ticket`: `{ "key": "ABC-12" }` links a local task or bug to an existing ticket (an optional `connectionId` picks the tracker), `null` unlinks it. Answers with the item. |
| `GET /v1/milestones` | Milestones with their status, progress and share of time gone, the counts of tracker milestones, the `pieces` of a milestone made of pieces (each with its `kind`, `key`, `itemId` or `url`, `title`, `state`, `weight` and `share`), their notes (shortened to 1000 characters), links, and when and by whom (`user` or `agent`) they were last changed. `agentChanges` says whether changes wait for you (`ask`) or apply at once (`allow`); `pending` lists the proposals not applied yet. |
| `POST /v1/milestones` | Creates a milestone: `name`, `start` and `end` (`YYYY-MM-DD`), and one of `progress` (0–100, typed by hand), `query` (a tracker query, with an optional `connectionId`) or `items`, its pieces: `{ "kind": "ticket", "key": "ABC-12" }`, `{ "kind": "task", "itemId": "…" }` or `{ "kind": "link", "url": "https://…", "label": "…", "done": false }`, each with an optional `weight` from 1 to 10 (5 by default), at most 100 (a `task` must be an item of the same profile's inbox); `notes` (Markdown), `link`, `links` (as for inbox items) and a short `reason` are optional. |
| `PATCH /v1/milestones/:id` | Changes `name`, `start`, `end`, `progress` (a typed milestone) or `query` (a counted one), `items` (replaces the pieces, and turns any milestone into one made of pieces), `notes`, `link` or `links` (`null` clears them; `links` replaces the whole list). |
| `DELETE /v1/milestones/:id` | Deletes a milestone. |
| `GET /v1/people` | Your people's names, emails and handles, to match attendees. Notes are not shared. |

Milestone changes follow **Settings → Profiles → (profile) → Screens → Plan → Inbox → Milestone changes by agents**. With **Ask me
first** (the default) a change answers `202` with `pending: true` and waits under **Proposed by
agents** on the Milestones tab, showing what would change; **Apply** saves it, **Reject** drops
it. A proposal over a milestone you edited after the agent asked cannot be applied, so an old
proposal never undoes your edit. With **Apply at once** the change answers `200` with
`applied: true`.

Every change an agent makes this way that is in effect (items it proposes, its edits and notes on
items, milestone changes applied at once) also waits under **Changes by agents**. Home shows how
many wait, by kind, and when the latest happened; **See changes** there, or the **Changes by agents**
entry in the sidebar, opens a window that lists them with the fields before and after (for an item
the agent added, what it holds, without its id or where it came from). The window updates on its
own, and opening it again brings it to the front. **Keep** marks it as reviewed; **Revert** puts the values from before
back (a proposed item is discarded, a milestone it created is deleted, one it deleted comes back).
Revert refuses when the item or milestone changed again since, so it never undoes a later edit; a
value too long to keep in the journal (over 2000 characters) is shown shortened and must be changed
by hand. Proposals that wait under **Proposed by agents** are not listed there: Apply and Reject
review them already.

```sh
curl --unix-socket "$WORKHUB_SOCKET" -H "X-Workhub-Token: $WORKHUB_SESSION_TOKEN" \
  "http://workhub/v1/inbox?session=$WORKHUB_SESSION&status=local&q=rollout"
curl --unix-socket "$WORKHUB_SOCKET" -X PATCH http://workhub/v1/inbox/<id> \
  -H "X-Workhub-Token: $WORKHUB_SESSION_TOKEN" -H 'content-type: application/json' \
  -d '{"session":"'"$WORKHUB_SESSION"'","status":"done","note":"Sent in the release thread"}'
```

On Windows the session has `WORKHUB_URL` and `WORKHUB_TOKEN` instead of `WORKHUB_SOCKET` (a loopback
port with a token made at each launch): replace `--unix-socket "$WORKHUB_SOCKET" http://workhub` with
`-H "Authorization: Bearer $WORKHUB_TOKEN" "$WORKHUB_URL"` in these examples, and keep the
`X-Workhub-Token` header: the launch token only reaches the endpoint, the session token says which
session is calling.

What an agent cannot do: approve an item. Turning a task or bug into a tracker issue stays your
action on the Inbox tab; an agent only proposes items, keeps, closes, discards or reopens them,
edits their date, area, criticality and detail, and links or unlinks an existing ticket. A
change an item does not allow (a decision marked done, an item already sent to the tracker moved by
status, a ticket linked to a pending item) is refused with the reason. Every change shows up at once in an open Plan screen.

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
people, meeting rules, milestones in every status (one made of pieces: two tickets in different
states, a local task and a link) and an inbox with items from meetings, items in the tracker and a
local task linked to a demo ticket. Briefs
do not start by themselves in the demo; **Prepare brief** does start a real agent session.
