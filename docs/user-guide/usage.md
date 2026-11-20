# Usage and budgets

Workhub shows how much of each plan your agent accounts have used, lets you set ceilings that
keep automatic work under a limit, tracks token spend per folder, and reports tokens, cost and
agent time per project, ticket, pull request, agent, model, account or tag
([Usage and reports](#usage-and-reports)).

## Plan usage

Usage cards show, per account, the windows of the plan: Claude's **5h** and weekly windows, Kiro's
credits (used, left and the reset day, plus credits spent per day) and Codex's rate limits. They
appear on Home, in the session monitor and in the menu bar panel. Agents billed by API key (OpenCode,
Codex or Claude on an API key, ACP agents that report a cost) show **API spend**, from what their
sessions report, priced at list prices where only tokens are known.

Where the numbers come from is set under each agent's card in **Settings → Agents**:

| Switch | Default | What it does |
|---|---|---|
| **Show plan usage** (Claude) | Off | Every 5 minutes, calls an undocumented Anthropic endpoint (the one Claude Code's `/usage` uses) with the account's stored sign-in. It can change or stop working at any time. While it is off, usage comes only from what running sessions report. |
| **Show plan usage** (Codex) | Off | Every 5 minutes, calls an undocumented ChatGPT endpoint with the sign-in in the account's Codex folder, else falls back to the newest limits Codex wrote in its session files. Workhub never refreshes or stores that sign-in. |
| **Show credits left** (Kiro) | On | Asks `kiro-cli` for its own `/usage`, at most every 15 minutes and only while Workhub is open. Kiro runs briefly in a home folder of Workhub's own, so none of your MCP servers start and no session appears in Kiro's list. |

## Budgets (ceilings)

In **Settings → Agents**, **Edit** on an account (or on the agent's own sign-in) has **Stop sending
automatic work past the…**: a ceiling per window (**5h ceiling (%)**, **Weekly ceiling (%)**, Kiro's
**Monthly ceiling (%)**). Empty means no limit. The warning starts a few points below the ceiling.
Past a ceiling:

- prompts you send from Workhub to that account need **Send anyway** (or **Clear ceiling**);
- automations, Slack wakes and Slack reads on that account wait until the window resets or the
  ceiling is raised or cleared. **Run now** on an automation still runs once;
- a session can continue in another account of the profile, depending on **Account failover**
  (**Ask**, **Automatic**, **Off**) in the profile settings. **Ask** offers it in the chat
  (**Continue in {account}**, **Hand off to {agent}**, **Wait**); **Automatic** switches by itself.

Nothing is installed in the agents: the ceiling lives only in Workhub, and it lets everything
through while the usage is unknown.

### Dollar ceilings for agents billed by API key

An agent billed by API key has no plan window, so its card in **Settings → Agents** has **Dollar
ceilings (billed by API key)**: **Per day (USD)** (since local midnight) and **Per 7 days (USD)**
(the last 7 local days, as **API spend** adds them). Empty means no limit. They are set per agent
(Codex, OpenCode, Claude on an API key, an ACP agent that reports a cost), not per account, because
the spend is kept per agent. They work like the percentage ceilings: the warning starts a few
points below the ceiling (the same margin), past it a prompt you send needs **Send anyway** (or
**Clear ceiling**) and automatic work waits until the day turns over or the ceiling is raised or
cleared, **Run now** runs once, and the sessions' notice says the dollars spent against the ceiling.
When both a plan window and a dollar ceiling apply to an agent, the stricter one decides.

Tokens of a model with no known price are in no dollar total. Workhub never counts them as zero
silently: next to the ceilings, and in the notice, it says how many tokens are not included, so
read the spend as at least that much.

Usage alerts notify once per threshold and window, until the window resets. Their switch and
thresholds (comma separated, for example `80, 95`) are in
[Settings → Notifications and alerts](settings.md#notifications-and-alerts).

## Per-session limit

The monitor has **Usage limit for this session**: a ceiling for that one session, per window. It
replaces the account's ceiling for that window, higher or lower (100 lifts it). Past it, prompts
need **Send anyway**. It is kept with the session, also after a restart. **Use the account's
limits** removes it. Usage reading must be on for the agent to set one.

## Token spend

Home's **Token spend by folder** counts fresh tokens (input, cache writes and output) of Claude,
Codex and Kiro in the profile's folders over the last 7 days: the bar and main number are what
weighs on your plan. Cache reads, which are re-reads of context and would dwarf everything else but
cost much less, appear apart on each row as "+ cache". The session monitor splits the same way:
**Spent (fresh)** and **Cache reads** are separate boxes, and the detail rows keep **Context re-read
from cache**. Below the folders, **Workhub background** shows the tokens and cost of Workhub's own
model runs over the same days, every profile together (see below).

### Workhub background

Some model runs are started by Workhub itself, outside any session: each read of the
[Slack watcher](slack.md#what-watching-costs) and each summary of the chat's **Listen** button.
They leave no transcript, so Workhub records each one as it ends: one row with its tokens, model and
cost (as Claude reported it). In **Usage and reports** they are the agent **Workhub background**,
one session per kind (Slack watcher reads, Listen summaries) and Claude account, with no folder or
profile; a profile filter leaves them out. On Home they are a line of their own under **Token
spend by folder**.

## Usage and reports

**Usage and reports** (the **Usage** tab in the top bar, **View → Usage and reports**, or **See
reports** on Home's **Usage by agent** card; it has no keyboard shortcut) answers "how many tokens
and how much time went into each project or idea". It reads what Workhub records (see
[What Workhub records](#what-workhub-records)).

**Filters.** **Period**: **Today**, **Last 7 days**, **Last 30 days**, **This week** (from Monday),
**This month** or **Custom** (a **From** and a **To** day, both included, up to 540 days; when a
date is missing or the span is longer, the bar says which days it shows). The **Filters** button at
the end of the row opens a panel with one menu per filter with something to pick in that profile and
period: profile, project (that project only), **Folder and below** (a folder and every folder under
it), agent, account, model, ticket, pull request and tag (the **Tag** menu stays, greyed out, while no
session has a tag yet, and says where tags are added). The menus in use are tinted, the panel's foot
says how many sessions and turns the report counts, and **Done**, Escape or a click outside closes
it. The button says how many filters are in use (**Filters · 2**) and each one shows as a chip under
the row: its **×** removes it. The report opens on the active profile, as Session history does; pick **All profiles** to see
every one. **Group by** picks what the charts
and the table split by (project, agent, model, account, ticket, pull request or tag), and
**Measure** what they show: **Tokens** (fresh tokens: input, cache writes and output, as on Home),
**USD** (cost at list prices) or **Agent time**. **Clear**, beside the chips or in the panel,
removes every filter and puts a **Custom** period back to **Last 30 days** (a custom period that
ended days ago hides everything since; the presets always reach today and stay). The choices are
remembered on this computer.

**Charts.** The four tiles sum the period: fresh tokens (input, output and cache writes, which add
up to the figure, with cache reads apart),
cost at list prices, agent time and sessions. The bar chart shows the measure per day (per week
when the period is longer than 60 days), stacked by group; hover a bar, or Tab to the chart and
move with the arrow keys, for that day's numbers. Next to it, each group's share of the period as
a ranked bar with its exact value and percent of the period's total. The seven groups with the
most tokens get a color of their own and the rest fold into **Other**; a group keeps its color
when you switch the measure, but colors belong to the current view, so the same color can mean
another group under another filter or grouping. Clicking a group in the legend or the share list
filters by it (a project by that exact project; not **Other**, nor the "no value" group such as
**No ticket**). Grouped by ticket, pull request or tag, a session linked to several counts in each,
so shares can add up to more than 100%; the total stays the period's. Folders show by name in the
charts and shortened (`~/…/repo`) in the table; hover for the full path.

**Totals table.** Per group: sessions, turns, input, output and cache tokens, cost and agent time,
with a **Total** row, ten groups per page. Click a column header to sort by it (again to reverse, back on the first page). Grouped by ticket,
pull request or tag, a session linked to several of them counts in each, so the rows can add up
to more than the total.

**Export CSV** (top right of the table) saves the table as it is on screen, with the filters, the
grouping, the period and the sort in force, every group (not only the page shown). Workhub asks
where to save it; the suggested name carries the grouping and the dates
(`workhub-usage-by-project-2026-10-01_2026-10-27.csv`). Columns: group (in full, a folder path
or a pull request URL), input, output and cache tokens, cost in USD, sessions and agent time in
seconds, with numbers as plain digits (no thousands separators or units). The file is UTF-8 with
a byte-order mark, so spreadsheets read accents correctly, and fields with commas, quotes or line
breaks are quoted (RFC 4180). The Total row is not included. A group name that starts with
`=`, `+`, `-` or `@` gets a leading apostrophe so a spreadsheet does not run it as a formula.

**Sessions.** The sessions the totals count: those with agent work in the period that matches the
filters, most recent first, with that period's numbers, ten per page (the pager below reads
"11–20 of 57" and moves with **Previous page** and **Next page**; changing the filters or the period
goes back to the first page): title, date, agent, account, folder, turns, tokens, cost, agent time, linked tickets
and pull requests, and its tags. Clicking a title opens **Session history** searching for that
session, where you can resume it; a session whose transcript is gone is not listed there; one that
ran in a temporary folder is, because the search is its exact id.

**Tags.** Free labels for what a session was about (an idea, a client, a spike): lower case, up to
20 per session (at 20 the field says so; remove one to add another), each up to 40 characters.
Saving a tag reads the report again. Add them in the sessions list here, with **Tags…** in a Session history row's menu,
or in the **Tags** section of the session monitor. Return or a comma adds one; × removes it. Then
filter or group by tag.

**Weekly summary.** A card for one week (this week by default, Monday to Sunday; the arrows move
between weeks): agent time, cost and sessions, time and cost per project (projects under one
dollar fold into one **Other** row when there are two or more of them and something above the
line), and the pull requests and tickets the week's sessions were linked to. It follows only the profile filter, and says whose
week it is (a profile's name, or **All profiles**) next to **Copy summary**. **Copy
summary** copies it as Markdown in the app's language, ready to paste to someone who has never
seen Workhub: projects by folder name (with the parent folder when two share a name; never a full
path), pull request links, ticket keys, and a
line on what agent time and list prices mean.

**Monthly project budgets.** A card under the filters sets an optional budget per project for
the calendar month, in dollars, in tokens or both. While there is none it is a single line; **Set
one** opens its form (type tokens as `20000000`, `20M` or `800k`). Pick
the project from the list the reports know: a budget is kept under the project exactly as the
table groups it (the project folder, or the working folder when none was resolved), so a name typed
by hand that does not match never fills. The card counts from the 1st of the current month, over
every profile, whatever period the report above shows. Each project has a bar: normal, a warning
from 80 % and a red state from 100 % (of whichever of dollars and tokens is further along). Dollars
are list prices and leave out tokens of models with no price; when a project has some, the card says
how many, so read the dollars as at least that much.

Workhub also notifies when a project crosses 80 % and 100 %, once per month per threshold (a jump
from 70 % to 120 % announces only 100 %; raising a budget or a lower spend later does not announce
it again; a new month starts over). The notification follows the notification settings: the master
switch, **Pause notifications**, quiet hours, and the usage alerts switch in
[Settings → Notifications and alerts](settings.md#notifications-and-alerts). It is checked after
each transcript scan, every ten minutes or on **Refresh**. A budget never blocks anything: prompts
and automations run as usual.

What these numbers are not: cost is at list prices, not what a plan subscription bills; agent time
is the agent working, not your own time at the keyboard; only Claude, Codex and Kiro transcripts
on this computer are read (plus Workhub's own background runs), so other agents and other computers do not appear. Links to tickets
and pull requests exist only for sessions Workhub ran (it records what their monitor found).
Usage and reports is not offered to a paired phone.

## What Workhub records

To report time and spend per project, ticket, pull request, account, agent, model and tag, Workhub
reads the transcripts Claude, Codex and Kiro write on your computer (the same ones the token spend
comes from) and keeps one row per assistant message with token usage in its database: when it was
written, the model, the tokens, the cost at list prices, the folder it worked in and the project
that folder belongs to. It keeps no prompt or reply text; session titles and automation failure
reasons are kept as the app shows them. Sub-agents' tokens count, their time does not (it runs
inside the parent's reply). The
first scan after an update reads every transcript there is (the main log shows its progress);
later scans, every 10 minutes, read only what was appended. **Refresh** on the Usage screen first
reads the transcripts written since the last scan (the button spins meanwhile, for at most about
20 seconds), then reloads the charts and tables. Demo modes never read your transcripts. **Agent time** is the time from your prompt, or the
agent's previous reply, to each reply, with gaps longer than 30 minutes counted as 30.

Next to that it records the sessions you run in Workhub, the pull requests, tickets, branches and
worktrees their monitor relates them to, the tags you give them, every automation run, and the
pull request and ticket changes Workhub notices. All of it stays in `workhub.db` in the
[data folder](../architecture.md#data-folder); transcripts are read in place and nothing is sent
anywhere.

### How long it is kept

The per-message detail, the pull request and ticket changes and the automation runs are kept for
12 months. Once a day (a few minutes after start, then every 24 hours) messages older than that are
summed per day, session, model and folder and the detail is deleted; older pull request and ticket
changes and automation runs are deleted. Sessions, their links and tags stay, so the charts,
totals and the sessions table over a period that reaches back past 12 months add up to what they
did before, per day (a summary counts on its day, not at the hour of each message). Older weekly
summaries no longer list the pull requests opened, merged or reviewed and the ticket moves of
those weeks. A transcript older than 12 months that Workhub never read before (an account added
later) is not counted.

**Settings → Advanced → Data** shows, under **What the data takes**, the rows and approximate size
of the usage detail, the usage summaries, History's search index, the events and automation runs,
and the app's state, the free space in the file and when the cleanup last ran. **Compact now** runs
the cleanup at once and then rewrites the file so it shrinks to what it holds (on a large database
this takes a while; the Usage screen's reports wait for it).

## Ask your agent about your usage

An agent running in Workhub can read that data, read-only, to answer questions like "how much did I
spend on ABC-123?", "which sessions worked on this pull request?" or "write my weekly report". It
uses three tools of Workhub's MCP (or the `workhub-analytics` skill, which calls the same endpoint):

| Tool | What it gives |
|---|---|
| `usage_report` | From the usage database: dollars, tokens (input, output and cache writes, as on Home), agent time and sessions per project, ticket, tag or agent over a span, per day or week (filters: folder, pull request, ticket, model, agent, tag), or a weekly summary (time and dollars per project, pull requests and tickets worked on, PRs opened, merged and reviewed, ticket moves). It reads the session's profile unless asked for another one or all. |
| `analytics_schema` | The tables and columns the agent may read (sessions, turns, their links and tags, automation runs, pull request and ticket events, flow maps and flow history), how to query them and example queries. |
| `analytics_query` | One SQL query (`SELECT` or `WITH`) over those tables: at most 2000 rows, stopped after 5 seconds. |

A **project** is the deepest project folder of a profile holding the folder the agent worked in (a
worktree counts for its repository), else the git repository root, else the folder itself.

For example: *"Using my Workhub usage, give me a short report of last week: hours and dollars per
project, and the tickets and PRs I worked on."*

Workhub sends nothing anywhere through these tools; the answers become part of the agent's
conversation, which goes to your agent's provider like any other tool output. Reads are not limited
to the session's profile (like the History an agent can read). Workhub refuses anything but a
single read (no changes, no `PRAGMA` or `ATTACH`, no file functions) and runs each query in a
separate process on a read-only connection; a query that takes longer than 5 seconds is stopped
and cannot freeze the app. App state (`kv_state`, where things like device pairing live), the schema
bookkeeping, the transcript scan's bookkeeping (file paths on your computer) and the History search
index (first prompts of every profile's sessions) cannot be read. Where the app's SQLite has no
authorizer to back that up, `analytics_query` refuses every query ("read-only guard unavailable")
and `usage_report` still answers. Reviewer sessions may use the tools too; paired devices cannot.
Each query's text (not its values) is written, shortened, to the diagnostics log.

## Reviving an idle conversation

Agents cache the conversation's prompt so each message re-reads it cheaply. The cache lasts a few
minutes (Claude: 5 minutes or 1 hour, renewed by every request). Once it expires, the next message
sends the whole context again at full price: for Claude, 1.25x (5-minute cache) or 2x (1-hour
cache) the input price, against 0.1x or less for a cache read.

The composer warns before that happens:

- **Claude**: Workhub reads the cache lifetime each request asked for from the session's
  transcript, so the notice shows only once the cache has really expired, with the estimated
  cost at list prices next to what a warm cache would cost.
- **Codex and Kiro** report the context size but no cache lifetime: the notice shows after 5
  minutes without activity and says the cache has likely expired, with the context size only.
  Agents that do not report the context size (OpenCode) show no notice.

It shows when the context is at least 20k tokens and, when the cost is known, when a cold resend
costs at least $0.05, so a cheap model's large context does not raise it. It never holds a
message; on a plan subscription the cost is in plan usage rather than money, in the same
proportion.

Next: [Settings](settings.md).
