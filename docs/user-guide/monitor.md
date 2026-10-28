# Monitor

The monitor is the panel next to a session. It answers "what is this agent doing and what is it
costing" without reading the conversation. It reads the agent's own transcript every few seconds,
so it works the same whether you are in App or Terminal view. Drag its edge (**Resize the
monitor**) to change its width.

Each agent fills what it has. A field the agent does not report is hidden or shown as **not
reported by the agent**; a missing or unreadable transcript never breaks the session.

## What it shows

| Section | Contents |
|---|---|
| Session time | **Alive** (since it started) and **Active** (share of the session the agent was working, split into thinking, tools and idle time). |
| Tokens | For **This chat** or **all turns**: **Input**, **Output**, **Cache write**, **Context re-read from cache**, the part from subagents, and **New tokens per request** with a count of requests this turn. |
| Cost / Credits | The cost reported by the agent, or Kiro credits per turn. |
| Context window | How full the agent's context is. |
| Plan usage | The plan windows of the session's account, when usage reading is on. See [Usage and budgets](usage.md). |
| Subagents | The agent's sub-agents; open one in its own window. |
| MCP servers | Status of each server (**running**, **needs sign-in**, **failed**, **disabled**, **loading**). With Claude Code you can **Refresh MCP status**, **Reconnect** or **Enable/Disable** a server. |
| Activity | The tool calls so far: commands run, files read, edited or written, searches, pages fetched, subagents started. |
| Tickets, Pull requests | The tickets and pull requests the session worked on, found from its tool calls. With a tracker connected, tickets show their title and status; click one to open it. |
| Local changes | Uncommitted changes in the repos the session worked in (files and repos), with a **clean** marker per repo. |
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
  7 days, read from their transcripts in the background. It counts fresh tokens (input, cache writes
  and output) and leaves out cache reads, which would dwarf everything else. A session counts for
  the folder its edits and commands worked in.

A card that depends on something not configured says so and links to **Settings**.

Next: [Review before PR](review-before-pr.md).
