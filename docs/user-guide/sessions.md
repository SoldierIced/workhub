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
  Kiro and OpenCode) and **Mode** (permission or approval mode). **Agent** lists the profile's
  agents in its order, the first one marked **(default)** and the other accounts with their usage
  when it is known; its last item, **Order and pick agents of {profile}…**, opens the profile's
  **Agents** tab in Settings (see [Profile › Agents](settings.md#profile--agents)). When the
  account picked has a default model, **Model** starts on **Account default**. The lists come
  from what the agent reports, so a new agent shows its models and modes after its first session
  (**List again** refreshes them). Claude's and Kiro's models are also read again for each account
  when Workhub starts, without sending a prompt, so a model gained since the last session (a
  Claude Code update, the `fable` alias moving to a newer Fable) is offered without opening one.
  Codex and OpenCode list theirs only when a session starts. **Use a worktree** and **Branch** start the session in its own git worktree;
  see [Worktree per session](profiles.md#worktree-per-session), which also covers `.worktreeinclude` (ignored files copied into the new worktree) and the setup command that prepares it; a notice at the start of the session reports both. **Group** lists the sidebar's
  session groups (a sub-group by its path, such as "Work / Backend"); it starts on **No group**.
  **New group…** shows a field for the name of a new group (a group with that name, if there is
  one, is reused). The session starts in the group picked.
- In the sidebar, the **Folders** section has a filter, **Favorites**, **Recent**, and then one
  section per folder of the profile: its name, how many folders it holds, and those folders
  (usually repositories) indented under it. Click a section's header to unfold or fold it; the
  sections start folded and Workhub remembers which ones you unfolded. The **+** on a header (or
  its right-click menu) starts a session in the folder itself. A folder that is a single project
  (nothing listed inside it) is a plain row. Typing in **Filter folders** searches every folder
  and shows the matches under their folder's section, unfolded. **New session in {folder}** starts
  one in any row.
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

Each terminal keeps 10,000 lines to scroll back through (change it in **Settings → General → Text size → Adjust…**, from 1,000 to 100,000). Workhub sends a
terminal's output to the screen in batches of about one frame, so a command that prints without pause (a long build log) does not slow the app down.

## The composer

- **Return** sends, **Shift+Return** adds a line, **Esc** interrupts the agent.
- **Earlier prompts**: **↑** in an empty message box (or with the caret on its first line) brings
  back the session's previous prompt; keep pressing for older ones (up to the last 50). **↓** comes
  forward and, past the newest, puts back what you were typing; so does **Esc**. Editing a recalled
  prompt makes it your draft.
- **Mention files with `@`**: type `@` at the start of a word (not inside an email address) and a
  few letters; a menu lists the session's files that match, by name or by letters of the path in
  order (`cpane` finds `ChatPane.tsx`). **↑** / **↓** choose, **Return** or **Tab** inserts the path
  relative to the session's folder (in backticks if it has spaces), **Esc** closes the menu. The
  list is the repository's tracked files plus untracked ones that are not ignored, from the
  session's folder or worktree, up to 20,000 files; a folder that is not a repository is walked
  instead (up to 5,000 files, skipping hidden folders and `node_modules`). The list is kept for a
  few seconds. Paired phones do not have it.
- Under the input, two small menus show the session's **Model** and **Mode** (permission mode, or
  the agent for Kiro and OpenCode). Change them live. When the agent does not let a session switch
  one, it is shown without a chevron. The mode is tinted when tools run unattended, such as
  **Bypass permissions**. The effective permission mode is always shown, because the agent's own
  default applies.
- **Queueing**: while the agent works you can keep typing. The message waits and is sent when the
  turn ends (**Queued: sent when the agent finishes**). With Claude Code the message joins the turn
  in progress instead. If you interrupt, queued messages come back into the composer, unsent. Each
  queued message has a **Remove queued message** button.
- **Pasted images**: paste or drag images into the composer (agents that accept images only: PNG,
  JPEG, GIF or WebP, up to 3.75 MB each). They show as thumbnails you can remove, and
  appear in the conversation, where **Click to view** opens them in the file viewer.
- **Timestamps**: every message shows the day and hour it was sent; hover for the full date with
  seconds.
- **Permission requests** stay pinned above the message box, whatever the conversation scrolled
  to, until you answer them; the conversation keeps a line where each was asked, and the answer
  once given. They survive closing and reopening the window and reach a paired phone, and a request
  answered elsewhere (the phone, another window) shows as such; one the agent withdrew, or that a
  stopped turn left behind, shows as withdrawn. Above the message box a line says how many requests
  wait for your answer; after you answer one, the focus moves to the next request or back to the
  message box. From the keyboard, **⌘/Ctrl+Shift+A** moves the focus to the oldest request, and
  **1**-**9** pick its buttons in order. While one waits and the session is not on screen (its window visible and focused),
  Workhub notifies again at the interval set in **Settings → Notifications and alerts** (15 minutes
  by default, counted again from when you last looked at it; it follows the **Needs an answer**
  switch and an automation's own Notify setting).
- **Questions**: when Claude Code asks a question with choices, the same pinned card shows each
  question with its options (one, or several when it says so) and an **Other** field for your own
  answer; **Send answer** sends them all, **Skip** declines. A question still open when the session
  stops or switches to the console is marked withdrawn, so the session no longer waits for an answer.
- **Compaction**: when Claude Code compacts the conversation (on its own or with `/compact`), the
  conversation shows **Compacting the conversation…** and then a divider with how it started and
  how many tokens were summarized; **Show the summary** opens the summary Claude Code kept, when it
  reports one. A compaction that fails says so with its reason.
- **Long messages**: a message of yours taller than about 25 lines on screen (a pasted log or
  crash report, even one with no line breaks) is shown collapsed; **Show more** opens it, **Show less** folds it again. Long lines
  wrap inside the bubble, and code blocks and tables in replies scroll inside themselves.
- **Long conversations**: the conversation shows its latest 200 or so messages, starting where one
  of your messages begins; **Show earlier messages** at the top shows the next 200 above, without
  moving what you are reading. The conversation follows new output while you are at its bottom;
  scroll up while the agent writes and **Jump to latest** takes you back down.
- **Copy**: under each message of yours and each reply, next to its time.
- **Find in the conversation**: **⌘/Ctrl+F** (View → **Find in Conversation**) opens a find bar over
  the chat. It ignores case, shows which match you are on (**3 of 12**), and **Return** /
  **Shift+Return** or the arrows go to the next and previous match, wrapping around at the ends.
  Matches are highlighted and the chat scrolls to the current one. It searches your messages, the
  replies, errors and the names of tool calls, not collapsed thinking or tool output. **Esc** closes
  the bar. It works in the App view; the Terminal and Shell views are not searched.
- **Listen**: next to **Copy** under each agent message. A short message (under about 400
  characters once code, links and formatting are left out) is read aloud as it is. A longer one is
  first summarized into a few spoken sentences, in the message's language, by a small Claude model
  (**haiku** by default, **Settings → General → Voice → Model to summarize before reading**) on the session's Claude
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

In the agent's replies:

- A file path written as code (`src/app.ts`, `~/notes.md`, `README.md`, with or without a
  `:line`) or used as a link opens in Workhub's file viewer when clicked, if that file exists on
  this computer (a branch such as `feat/x` stays plain text). Relative paths start from the
  session folder. The viewer can also open the file in its default app or show it in its folder.
- A shell code block (`sh`, `bash`, `zsh`, `powershell`, `cmd`) has a run button next to copy: it
  opens the Shell view and types the command there, without prompt marks, output lines or comments.
  It runs only when you click.

## Header and More

The header shows the agent, the account, the folder, what the agent is doing with a timer
(**Starting**, **Working**, **Needs you**, **Idle**, **Stopped**, **Error**), the Slack threads
that wake the session, and **Stop**. On a narrow window the secondary controls fold into **More**.
The panel button at the right end (**Hide the monitor**, ⇧⌘M) folds the side panel away and
brings it back; its icon shows whether the panel is open.

- **No output for …**: a session that is working and whose agent has sent nothing for 10
  minutes (the limit is in **Settings → General → On open and close**, or off) shows a notice
  under the header and **No output for …** in place of **Working**, with **Stop** and **Keep
  waiting**. Nothing is stopped for you: the agent may be thinking. **Keep waiting** asks again
  after another full interval, and any new output from the agent clears the notice. A session
  that waits for a permission or an answer is never flagged. A session that is still **Starting**
  after 60 seconds is stopped and shows the error, for the Claude Code bridge as for other agents.
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
  [History](history.md). In the sidebar, a folder's menu has **Resume session…**. Claude Code,
  Kiro, OpenCode and Codex sessions can be resumed, also by reopening a closed one from its group.
  Kiro, OpenCode, Codex and Gemini CLI continue the conversation only when the agent can load or
  resume a past session; otherwise a new conversation starts below the earlier messages, with a
  **New conversation** notice saying the agent does not remember them. When another Codex client
  holds the conversation, the session shows Codex's error instead; reopening it after closing that
  client replaces the failed copy.
- **Rename**: **Rename…** in the session's menu, or double-click its name, or `/rename <name>` in
  the chat. Leave the name empty to show the agent's name again.
- **Export conversation…**: in the session's menu in the sidebar. A save dialog asks where; the
  file is Markdown named after the session and the date (`my-session-2026-11-05.md`). It has your
  messages and the agent's replies in order with their times (UTC), each tool call as one line
  with its status, and no tool output.
- **Sign in** (Claude): `/login` in the chat opens the Terminal view and runs `/login` there, since
  Claude Code only signs in from its terminal UI. Once signed in, go back to App (⌘⌥1).
- **Remote Control** (Claude): `/remote-control` (or `/rc`) in the chat opens the Terminal view and
  runs `/remote-control` there, since Claude Code only turns it on from its terminal UI. Remote
  Control stays on only while the Terminal view runs: a session has one engine at a time, so
  switching back to App stops the console and ends it.
- **Terminal-only commands** (Claude): commands Claude Code runs only in its terminal UI, such as
  `/plugin`, `/config`, `/resume`, `/statusline` and `/ide`, show in the `/` menu marked **opens in
  Terminal**. Picking or typing one (with its arguments, on one line) opens the Terminal view and
  runs it there; go back to App (⌘⌥1) when you are done. Workhub only types commands the session
  reports as terminal-only, never other text. The menu also shows a command's aliases (`/stats` for
  `/usage`), and typing an alias finds it.
- **Close**: the close button on the row, `/exit` in the chat (in App mode, for every agent;
  anything typed after it is ignored), or ⌘/Ctrl+Shift+W. A session that is working asks first
  (**Stop and close**). A session in a worktree Workhub created offers to keep or remove the
  worktree. The conversation stays in History. In the Terminal view, `/exit` goes to the agent's
  own terminal UI as before.
- **Delete session**: in the menu of a session that is closed or stopped, in a group or not. It
  asks first, then takes the session out of the sidebar, and out of its group, for good. The
  conversation stays in History and in the agent's own files; nothing is erased there. A session
  that is running is closed first (the close button, or **Close session**).
- **Keep my sessions in the sidebar** (**Settings → General → On open and close**, on by default):
  every session in the sidebar when Workhub quit, running or stopped, comes back in its group and
  window, **stopped**: no agent process runs and nothing is spent until you open it, which resumes
  its conversation (with the notice above when the agent cannot). **Delete session** takes one out of the sidebar for good; it stays in
  History. **Start them when Workhub starts** (off by default) runs every one again right away
  instead. Nothing is sent to the agents either way.

## Quitting while sessions are busy

Quitting Workhub (⌘Q, the menu, or **Restart now** after an update) would stop running turns
and drop queued prompts and unanswered requests. So when any session is working, has prompts
waiting or has an open permission request, Workhub asks first and says how many of each:

- **Quit anyway** (**Restart anyway**): stops everything and quits.
- **Quit when idle** (**Restart when idle**): quits by itself once no session has been busy for
  a few seconds. A banner at the top of the window says it is waiting and has **Cancel**; a new
  prompt simply postpones it.
- **Cancel**: stays open.

Prompts waiting in a window's own queue are not counted themselves (only the main process is
asked); they only exist while a turn runs, so that session already counts as working.
Shutting the computer down or logging out never waits: Workhub quits at once. Turn the question
off with **Ask before quitting while sessions are busy** in **Settings → General → On open and
close**.

## Detached windows

**Open in New Window** (session menu, **File → Open Session in New Window**, ⌘/Ctrl+Shift+N) moves
a session to its own window. The main window shows "This session is in its own window" with **Show
Window**; closing that window, or **Move to Main Window** there, brings it back. Sub-agents can also
be opened in a new window.

Every window shows the whole chat of a running session, including messages sent from another
window or a paired phone, and a window that reloads (by itself after a crash, or with **Reload**)
gets its chats back. Workhub keeps the latest part of each chat for this; a very long chat starts
with "Earlier messages are not shown", and the full conversation stays in History.

## The sidebar

- Sessions are listed with the agent icon, the account, and the colour of their profile down the
  left edge.
- Attention flags appear when a session, while not on screen, finishes a turn (**Ready to
  review**), asks for a permission or an answer (**Needs an answer**) or fails (**Error**). The app
  icon badge and OS notifications follow the same events (**Settings → Notifications and alerts**).
  A session whose console asks for a permission or a question counts as **Needs an answer** too,
  until you press Enter in that console or it stops.
- **From the keyboard**: **⌘/Ctrl+Alt+↓** and **⌘/Ctrl+Alt+↑** show the next and previous session
  in sidebar order, and **⌘/Ctrl+J** jumps to the next session that needs you (**Needs an answer**,
  **Ready to review** or **Error**), cycling through them. **⌘/Ctrl+K** opens the command palette:
  type part of a session's name, folder or state, a screen, **New session** or a Settings section
  or setting, and press Return.
- **Groups**: **New group** creates a folder of sessions. Drag a session onto a group or onto
  another session to move it; drag groups to reorder them. The row menu has **Move up** and **Move
  down** (Alt+↑ and Alt+↓), **Move to group**, **Take out of group**, and for groups **Rename
  group…** and **Delete group** (its open sessions go back to the list; nothing is closed). A
  closed session stays in its group, marked **Closed**; click it to reopen, or **Delete session**
  to take it out of the sidebar for good. Order within each group is kept.
- **Sub-groups**: a group's menu (right click, or its **…**) has **New session** (the New session
  dialog with that group picked), **New sub-group…**, **Move into group** and, for a sub-group,
  **Move to the top level**. Sub-groups are listed inside their group, before its sessions, and
  can nest at any depth; a group cannot go into one of its own sub-groups. Folding a group hides
  its sub-groups too, and its header counts the sessions inside them. Deleting a group moves its
  sub-groups and open sessions to where the group was.
- Sub-agents of a session can be shown or hidden under it.
- **Background work** (Claude): while the agent waits on something it left running, such as a
  command in the background ("wait for the CI checks") or a watcher, its row shows a timer with
  the number of tasks (hover for what each one does), and the chat shows them above the message
  box with how long each has run. They disappear when the tasks end or the session stops.
- **Requests from agents**: a row with an inbox icon and a number has requests from its agent waiting
  for you (see below).

## Agents that work with other sessions

With Workhub's tools for agents on (**Settings → Agents → Workhub tools**, or the
`workhub-sessions` skill), an agent can see the other sessions of its profile (name, agent,
folder, state and whether one needs you; never what was said in them) and ask for two things.
Neither happens until you say so:

- **Start a new session**: the agent proposes an agent, a folder of the profile and a first
  prompt. A bar at the top of the proposing session shows the whole prompt with **Start session**
  and **Dismiss**. Approved, the session starts in a mode that asks before acting (as a start from
  a phone: never one that skips permission prompts) and gets the prompt once it is ready.
- **Send a message to another session**: the first message from one session to another shows in
  the sending session with **Allow and send** and **Dismiss**. Once allowed, later messages from
  that session to that one go through until Workhub quits. Each arrives as "Message from session
  <name>", its text set apart as data from another agent, not as your instructions. Reviewer
  sessions never send or receive messages.

You also get a notification for each request; its click opens the session that asked. At most 3
requests of a session wait at once, and proposals and messages are rate limited. Requests end when
Workhub quits or the session that made them is closed.

An agent can also raise a notification of its own (a title and one line), for example when a long
task is done. It follows **Settings → Notifications and alerts** like a session's reply, and is
rate limited. None of this is available from a paired phone.

Next: [Monitor](monitor.md).
