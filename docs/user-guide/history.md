# History

**History** (⌘/Ctrl+6) lists the sessions of every configured account and agent, grouped by folder.
It reads the agents' own session files, so it also shows sessions that were not started in Workhub.
Sessions in temporary folders are not listed.

## Find and filter

- **Search sessions** matches titles and prompts.
- Filter by **Profile**, **Account** and **Agent**.
- **Reload** reads the sessions again.

## Resume

- Double-click a session, or use **Resume** / **Resume in the App**, to continue it in the app.
- **Resume in Console** continues it in the agent's terminal UI.
- The row menu also has **Reveal Folder**, **Copy Session ID** and **Open** (shows the session if it
  is already open).

Only Claude Code sessions can be resumed so far; the sessions of Kiro, OpenCode and Codex are listed
for reading. A resumed conversation replays its earlier messages and marks where it resumed.

Runs of an automation reuse its open session and are grouped in History.

You can also resume from a folder (**Resume session…** in the folder's menu in the sidebar), and from
a pull request or ticket, where **Past sessions** lists earlier sessions that mention it and why they
matched (same PR, same branch or same ticket).

Next: [Usage and budgets](usage.md).
