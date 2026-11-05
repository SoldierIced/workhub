# Monitor

The monitor is the panel next to a session. It answers "what is this agent doing and what is it
costing" without reading the conversation. It reads the agent's own transcript every few seconds,
so it works the same whether you are in App or Terminal view. Drag its edge (**Resize the
monitor**) to change its width. The panel button at the right of the top bar (**Hide the
monitor**, ⇧⌘M; Ctrl+Shift+M on Windows and Linux) folds it away and brings it back; the choice is
kept. The button at the left of the top bar (**Hide the sidebar**, ⇧⌘S) does the same for the
sidebar.

Each agent fills what it has. A field the agent does not report is hidden or shown as **not
reported by the agent**; a missing or unreadable transcript never breaks the session.

## What it shows

| Section | Contents |
|---|---|
| Session time | **Alive** (since it started) and **Active** (share of the session the agent was working, split into thinking, tools and idle time). |
| Tokens | For **This chat** or **all turns**: **Spent (fresh)** (input + cache write + output, what weighs on your plan) and, apart, **Cache reads** (they cost much less), then the detail rows **Input**, **Output**, **Cache write**, **Context re-read from cache**, the part from subagents, and **New tokens per request** with a count of requests this turn. |
| Cost / Credits | The cost reported by the agent, or Kiro credits per turn. |
| Context window | How full the agent's context is. |
| Plan usage | The plan windows of the session's account, when usage reading is on. See [Usage and budgets](usage.md). |
| Subagents | The agent's sub-agents; open one in its own window. |
| MCP servers | Status of each server (**running**, **needs sign-in**, **failed**, **disabled**, **loading**). With Claude Code you can **Refresh MCP status**, **Reconnect** or **Enable/Disable** a server. |
| Activity | The tool calls so far: commands run, files read, edited or written, searches, pages fetched, subagents started. |
| Tickets, Pull requests | The tickets and pull requests the session worked on, found from its tool calls. With a tracker connected, tickets show their title and status; click one to open it. |
| Local changes | Uncommitted changes in the repos the session changed (files and repos), with a **clean** marker per repo. A repo counts when the agent (or one of its sub-agents) edited or wrote a file in it, ran a git command that writes there (commit, push, merge, rebase, cherry-pick, revert, a new branch), or ran `gh pr create` or `gh pr merge` there. A repo it only read (`cd`, `git log`, a search) does not count, and neither does one it changed only through other shell commands (a redirect into a file, `sed -i`, a code generator) until it commits there. |
| Slack | Threads that wake this session and messages about its tickets and pull requests. See [Slack](slack.md). |

Pull requests and tickets from the monitor open in Workhub (**View in app**) or on the code host
(**Open on the code host**).

If a section says a tracker or the Slack watcher is not set up, its message links to the right
Settings tab.

## Session limits

The monitor also holds **Usage limit for this session**, a ceiling for this one session. See
[Usage and budgets](usage.md).

## Home

**Home** (⌘/Ctrl+1) summarises the active profile:

- **Needs you**: sessions grouped by **Needs an answer**, **Ready for review**, **Working** and
  **With errors**, each with an action (**Answer**, **Review**, **Open**).
- **My open pull requests** and **Waiting for my review**, with counts.
- **Tickets in progress**: tickets assigned to you.
- **Plan usage**: the highest usage window across the accounts that report one.
- **Environments**: the Health state of each environment, when the Health module is on.
- **Token spend by folder**: tokens of Claude, Codex and Kiro in this profile's folders over the last
  7 days, read from their transcripts in the background. The bar and main number are fresh tokens
  (input, cache writes and output); a smaller "+ cache" figure shows the cache reads apart, because
  they are most of the volume but cost much less. A session counts for the folder its edits and
  commands worked in.

A card that depends on something not configured says so and links to **Settings**.

## Menu bar panel

On macOS and Windows a click on the menu bar / notification area icon opens a small panel (Linux
keeps the native menu). It follows the system's light or dark appearance, not the app theme, and
has no boxes: every line is a flat row (an icon or a colored dot, the text with an optional small
second line, a value on the right), with a small uppercase title per block and a thin line
between blocks.

- **Header**: the verdict (**2 sessions need you**, **3 working**, **All caught up** or **No open
  sessions**), and below it the active profile, the number of open sessions and, while
  notifications are paused, until when (**muted** for a pause until you resume). A click on it
  opens the main window; **✕** closes the panel.
- **Today**, left out when it has nothing:
  - the next meetings of today from the Plan calendars (2 by default): the title, then the time,
    the call service or the room and, when it is close, how soon. The one that starts within 15
    minutes shows **Join** when it has a call link. A click joins the call, or opens Plan when there
    is no link.
  - Plan inbox tasks due today or overdue (up to 2); a click opens Plan.
  - **Pull requests** (to review and mine), while the profile has a code host.
  - **Health**, only while an environment is degraded or unreachable.
  - **Slack**, only when watching stopped with an error.
- **Usage**: one row per agent account that reports usage: the name, a bar for its most spent
  window (amber from 75 %, red from 90 %) and the percentage. A click opens **Settings → Usage**.
- **Sessions**, shown only when they have something: **Needs you** (up to 5, with the state and how
  long ago), **Working** (up to 3) and **Recent** notifications (up to 4, with **Clear**). Recent
  leaves out notifications about a session already listed above. **N more** opens the app.
- **Footer**: **New session**; the bell, with **Pause for 1 hour**, **Pause until tomorrow**,
  **Mute until I resume** and **Notification settings…** (while paused the bell turns amber and its
  menu starts with **Resume**); **Settings**; and **⋯** with **Check for updates** (when available)
  and **Quit**.

Escape, a click outside the panel or **✕** closes it; the arrow keys move between rows and buttons.

**Settings → Notifications → Menu bar panel** chooses the blocks: **Meetings** (and how many, 1 to
3), **Plan tasks**, **Pull requests**, **Health**, **Usage** and **Recent notifications**. All are
on by default. Slack has no switch: it only appears when watching fails.

Next: [Review before PR](review-before-pr.md).
