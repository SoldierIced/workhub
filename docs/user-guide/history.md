# History

**History** (⌘/Ctrl+6) lists the sessions of every configured account and agent, grouped by folder.
It reads the agents' own session files, so it also shows sessions that were not started in Workhub.
Sessions in temporary folders are not listed, unless the search is a session's exact id (as when
you open one from Usage and reports).

## Find and filter

- **Search sessions** finds every word you type in the title, first prompt, folder, branch and
  session id of every session, and in the conversation of Claude Code sessions (what you wrote and
  what the agent answered; tool output is left out). Kiro, OpenCode and Codex sessions are found by
  title, prompt, folder and branch only: Workhub cannot read their conversations yet. The last word
  also matches the start of a word (from two letters on), accents do not matter (`cancion` finds
  `canción`), and any part of a title, prompt, folder or branch matches too (`gateway` finds
  `PaymentGateway`).
- With words in the box the results are one list, best match first, each with the text around the
  match highlighted and its folder; **Show more** loads the next 50. The filters below still apply.
- Filter by **Profile**, **Account** and **Agent**.
- **Reload** reads the sessions again.

### Older sessions

To keep start-up quick, History reads the newest 400 sessions of each account from their files.
Older sessions that are already in the search index stay listed and searchable without being read
again (Claude Code; for Kiro, OpenCode and Codex they stay in the index but are not listed). When an
account has more, the end of the list says so and **List older sessions** reads 400 more of each
account, which are then indexed and stay listed from then on. A session leaves History and the
index only when its file is gone.

### The search index

The search uses an index Workhub keeps on this computer, inside its database (`workhub.db`, so the
copies in `backups/` hold it too); nothing is sent anywhere. It is built from the agents' session
files the first time Workhub starts with this version, then kept up to date every few minutes and
shortly after a session stops, reading only the sessions that changed (or were renamed). While it
builds, **Indexing… done/total · results may be incomplete** shows under the search box; sessions
not indexed yet still match by title, prompt, folder and branch, without an excerpt. A very long
conversation is indexed up to about 2 MB of text. The index takes about twice the size of the text
it holds (tens of megabytes for a few hundred long sessions); it is a cache, rebuilt from the
session files when needed.

On a paired phone, the search icon on the Sessions screen searches the same index, limited to the
profile's folders (see [Remote access](remote-access.md)).

## Resume

- Double-click a session, or use **Resume** / **Resume in the App**, to continue it in the app.
- **Resume in Console** continues it in the agent's terminal UI (Claude Code only: the other
  agents have no terminal view in Workhub).
- The row menu also has **Reveal Folder**, **Copy Session ID**, **Tags…** (labels for
  [Usage and reports](usage.md#usage-and-reports)) and **Open** (shows the session if it is already
  open).

Claude Code, Kiro, OpenCode and Codex sessions can be resumed. A resumed conversation replays its
earlier messages and marks where it resumed. ACP agents first try `session/load`; when the agent
supports `session/resume`, Workhub also tries that if loading is unavailable or fails. Resume
restores the agent's stored context without replaying messages into the window: a chat can have
its original context even when its earlier messages are not displayed.

If both attempts fail for Codex, the session shows the agent's error and keeps the original
session id; it does not start an empty conversation in its place. If the error says another Codex
client owns the session, close that conversation in the Codex app, CLI or IDE, then retry from
History. Workhub does not take over an active writer. An unsupported resume, or a failed resume
for another ACP agent, still starts a new conversation with a **New conversation** notice: any
earlier messages shown are history only and the new agent does not remember them.

Runs of an automation reuse its open session and are grouped in History.

You can also resume from a folder (**Resume session…** in the folder's menu in the sidebar), and from
a pull request or ticket, where **Past sessions** lists earlier sessions that mention it and why they
matched (same PR, same branch or same ticket).

## Agents and the history

An agent in a Workhub session can read the history through the local control endpoint
(`skills/workhub-automations`): `GET /v1/history` lists past sessions newest first, filtered by
`agent`, `automation` or `folder`; with words (`q`) it searches the index like the search box,
best match first, and each match carries the text around it (`snippet`); `GET /v1/history/<agent>/<session id>` returns the
last messages of one of them, with text shortened and tool output and images left out. It cannot
resume, rename or change a past session. These calls need the session's own token
(`WORKHUB_SESSION_TOKEN`); without it they are refused.

Next: [Usage and budgets](usage.md).
