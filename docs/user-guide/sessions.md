# Sessions

A session is an agent working in a folder. Workhub runs Claude Code (through the Claude Agent SDK,
or over ACP), Codex, Kiro, OpenCode and Gemini CLI (over ACP), or any CLI in a terminal. Each agent
declares what it supports, and the screen shows only the controls that agent has.

## Start a session

- **New session** in the toolbar (or ⌘/Ctrl+T, or **File → New Session**) starts your preferred
  agent in the profile's default folder with no questions. The preferred agent is the first one in
  the profile's agent order.
- **Choose agent and folder…** (the menu next to the button) opens the **New session** dialog:
  **Agent**, **Folder** (**Choose a folder**), **Model**, **Agent** (the persona, for agents like
  Kiro and OpenCode) and **Mode** (permission or approval mode). The lists come from what the agent
  reports, so a new agent shows its models and modes after its first session (**List again**
  refreshes them).
- In the sidebar, the **Folders** section lists the profile's folders, **Favorites**, **Recent**
  and **All folders**, with a filter. **New session in {folder}** starts one there.
- From a pull request or ticket, **Open session** or **New session about this ticket** start one
  with a prompt already in the composer. Nothing is sent until you press **Send**.
- **File → New {agent} Session** starts a specific agent. ⌘/Ctrl+L starts the first one, ⌘/Ctrl+Y
  a plain shell.

An agent that is not installed is marked **not installed**, with the command to install it.
Starting an agent can take 10 to 15 seconds while it loads its MCP servers.

## App, Terminal and Shell

The **View** switch in the session header changes how the same session is shown:

| View | What it is |
|---|---|
| **App** | A chat: messages, tool calls, permission prompts, the monitor and the composer. |
| **Terminal** | The agent's own terminal UI, in a PTY. It is the same conversation: Workhub hands the session over (for Claude Code it runs `claude` with the same session id). Offered only for agents that have a terminal UI Workhub can launch; a read-only reviewer session has none. |
| **Shell** | A plain shell in the session folder, next to the agent. |

Switch from **View → Show as App**, **Show as Console** or **Show as Shell** (⌘/Ctrl+Alt+1, 2, 3). If the agent is in the
middle of a turn, the switch waits for it ("Switches to Terminal when the turn ends") and you can
answer questions in the meantime; **Switch now** stops the turn and switches immediately, **Cancel**
stays in the current view.

## The composer

- **Return** sends, **Shift+Return** adds a line, **Esc** interrupts the agent.
- Under the input, two small menus show the session's **Model** and **Mode** (permission mode, or
  the agent for Kiro and OpenCode). Change them live. When the agent does not let a session switch
  one, it is shown without a chevron. The mode is tinted when tools run unattended, such as
  **Bypass permissions**. The effective permission mode is always shown, because the agent's own
  default applies.
- **Queueing**: while the agent works you can keep typing. The message waits and is sent when the
  turn ends (**Queued: sent when the agent finishes**). With Claude Code the message joins the turn
  in progress instead. If you interrupt, queued messages come back into the composer, unsent. Each
  queued message has a **Remove queued message** button.
- **Pasted images**: paste or drag images into the composer (agents that accept images only: up to
  6 per message, PNG, JPEG, GIF or WebP, 5 MB each). They show as thumbnails you can remove, and
  appear in the conversation, where **Click to view** opens them in the file viewer.
- **Timestamps**: every message shows the day and hour it was sent; hover for the full date with
  seconds.
- Permission requests appear in the conversation; answer them there.
- **Long messages**: a message of yours taller than about 25 lines on screen (a pasted log or
  crash report, even one with no line breaks) is shown collapsed; **Show more** opens it, **Show less** folds it again. Long lines
  wrap inside the bubble, and code blocks and tables in replies scroll inside themselves.
- **Listen**: next to **Copy** under each agent message. A short message (under about 400
  characters once code, links and formatting are left out) is read aloud as it is. A longer one is
  first summarized into a few spoken sentences, in the message's language, by a small Claude model
  (**haiku** by default, **Settings → General → Voice → Summary model**) on the session's Claude
  account (Claude's default account for other agents). Each summary is one small paid query that
  spends a few hundred to a few thousand tokens of that account; it is not counted in the
  token spend on Home. While it summarizes, the button shows a spinner (click to cancel); while it
  reads, click it to **Pause** and again to **Resume**, and **Stop listening** ends it. One thing
  is read at a time: starting another message stops the current one. If the summary fails (no
  Claude login, a limit reached, a timeout after about 45 seconds), a notice says so and the start
  of the message is read instead. The voice and speed are those of **Settings → General → Voice**;
  with **System voice**, a voice of the app's language is used when one is installed.
- **Idle notice**: agents keep the conversation's prompt in a cache for a few minutes (Claude: 5
  minutes or 1 hour, renewed by each request). When you come back to a session that has been idle
  past that, a notice above the composer says the next message sends the whole context again at
  full price instead of a cheap cache read. The number is an estimate of the conversation's current
  context size in tokens. When the agent reports a cost, the notice adds the estimated price at list
  prices, and the price with a warm cache when it is known. For Claude the transcript says when the
  cache expired, so the notice says "expired {time} ago"; for an agent that does not report it, the
  notice guesses with the shortest lifetime (5 minutes) and says the cache "has likely expired". It
  appears only for a context of 20,000 tokens or more (and, with a known cost, a resend over about
  US$0.05), and never while the agent is working. It only informs: sending is never held. Close it
  with the **x**; it stays closed until the conversation moves again, and it goes away by itself
  when you send a message or the agent starts working.
- If the session's account is past a usage ceiling, sending asks for confirmation (**Send
  anyway**), or offers to continue in another account. See [Usage and budgets](usage.md).
- If the conversation's prompt cache has expired, a notice above the input says how long the
  session has been idle, how many tokens of context the next message sends again at full price,
  and, for Claude, the estimated cost against a warm cache. It only informs; close it with **×**.
  See [Usage and budgets](usage.md#reviving-an-idle-conversation).

## Header and More

The header shows the agent, the account, the folder, what the agent is doing with a timer
(**Starting**, **Working**, **Needs you**, **Idle**, **Stopped**, **Error**), the Slack threads
that wake the session, and **Stop**. On a narrow window the secondary controls fold into **More**.

- **Review before PR** and **Review changes**: see [Review before PR](review-before-pr.md).
- **Files**: the files the agent edited, wrote or read in this session, opened in a file viewer
  window (text, images and PDFs).
- **Continue elsewhere**: **Continue in another account** (same conversation, copied to another
  Claude account of the profile) or **Hand off to…** another agent (a new session in the same
  folder with a summary drafted in its composer; the other agent gets a summary, not the
  conversation).
- Read replies aloud, per session, from the session's context menu in the sidebar. Voices and
  speed are in **Settings → General → Voice**.

## Resume, rename, close

- **Resume**: History lists past sessions of every account and agent; see
  [History](history.md). In the sidebar, a folder's menu has **Resume session…**. Only Claude Code
  sessions can be resumed so far.
- **Rename**: **Rename…** in the session's menu, or double-click its name. Leave the name empty to
  show the agent's name again.
- **Close**: the close button on the row. A session that is working asks first (**Stop and
  close**). The conversation stays in History.
- **Reopen sessions on launch** (**Settings → General → Sessions**): the sessions that were open
  when Workhub quit come back in the sidebar, in their groups and windows, and resume their
  conversations. Nothing is sent to the agents again.

## Detached windows

**Open in New Window** (session menu, **File → Open Session in New Window**, ⌘/Ctrl+Shift+N) moves
a session to its own window. The main window shows "This session is in its own window" with **Show
Window**; closing that window, or **Move to Main Window** there, brings it back. Sub-agents can also
be opened in a new window.

## The sidebar

- Sessions are listed with the agent icon, the account, and the colour of their profile down the
  left edge.
- Attention flags appear when a session, while not on screen, finishes a turn (**Ready to
  review**), asks for a permission or an answer (**Needs an answer**) or fails (**Error**). The app
  icon badge and OS notifications follow the same events (**Settings → General**).
- **Groups**: **New group** creates a folder of sessions. Drag a session onto a group or onto
  another session to move it; drag groups to reorder them. The row menu has **Move up** and **Move
  down** (Alt+↑ and Alt+↓), **Move to group**, **Take out of group**, and for groups **Rename
  group…** and **Delete group** (its open sessions go back to the list; nothing is closed). A
  closed session stays in its group, marked **Closed**; click it to reopen, or **Remove from group**
  to forget it. Order within each group is kept.
- Sub-agents of a session can be shown or hidden under it.

Next: [Monitor](monitor.md).
