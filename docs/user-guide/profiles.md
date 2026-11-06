# Profiles

A profile is one context of work, such as a company or a side project. It groups the folders you
work in, the connections it reads from (code host, ticket tracker, chat, Health), the agent
accounts it may use and the optional modules that are on. Switch profiles from the card at the top
of the sidebar. **Manage profiles…** and **Create a profile…** are in the same menu.

Edit profiles in the **Profile** group of [Settings](settings.md). The picker at the top of the group
starts on the active profile and lets you edit any other one (or **New profile…**) without
switching the app's active profile. Changes are applied with the save bar (**Save**, **Discard**);
leaving with unsaved changes asks first.

## What a profile holds

**Profile and folders** holds the name, symbol, colour, folders, folder options, worktrees, links,
environment variables, Slack archive time and "owns everything outside". **Modules and screens**
holds the optional modules, the connection each screen reads, and the profile's connections,
accounts and agents offered. The agent order and account failover are in **Agents and accounts**,
and AI review has its own section.

| Setting | What it does |
|---|---|
| Name, Id | The id is a short permanent identifier (lowercase letters, digits, `.`, `_`, `-`). It cannot be changed after saving. |
| Symbol, Colour | The icon of the profile in the sidebar (default: the first letter of its name) and the colour that marks its sessions down the left edge of their rows. |
| Folders | A list of folders on this computer: **Add folder…** opens the system folder picker (once per folder, as many times as you need), each row shows the short and the full path, and ✕ removes it. New sessions offer them first, and the pull request search falls back to their repositories. |
| Default folder | Where **New session** starts without asking: one of the folders, **Home folder**, or **Another folder…**. Empty means the first folder. |
| Folder options | Per folder: **Only git repos**, and **Each subfolder is its own project** (**Automatic**, **On** or **Off**). With it on, sessions in a subfolder group under a project named after it; Automatic splits this way unless the folder is itself a git repository. **Worktree for new sessions** (**As the profile**, **On** or **Off**) overrides the profile's worktree setting for sessions in that folder. |
| Accounts | The agent accounts offered when you start a session in this profile. |
| Agents offered | Which agents appear in the **New session** menu. |
| Agent order | The first agent is the default, and the one Workhub picks on its own (opening a session from a pull request or ticket, asking Claude to review). |
| Connections | At most one connection of each kind: code host, ticket tracker, chat, Health. **None** turns that feature off in this profile. Calendars are picked in **Settings → Plan**, where a profile can read several. Set in **Modules and screens**. |
| Optional modules | **Health**, **Chat watcher** (the Slack screen), **Automations**, **Flow maps** and **Plan** (meetings, reminders, briefs, people; see [Plan](plan.md)). Off hides their screens. Each row of **Modules and screens** shows the connection the screen reads and an **Edit** link to its setup. |
| Account failover | **Ask**, **Automatic** or **Off**: what a session does when its Claude account reaches its usage limit or your ceiling. See [Usage and budgets](usage.md). |
| AI review | Settings for the [review before PR](review-before-pr.md) feature. |
| Worktrees | Whether new sessions on a git repository start in their own worktree and branch, where the worktrees go, the branch prefix, the branch new ones start from and what closing a session does. See [Worktree per session](#worktree-per-session). |
| Slack | How long a thread stays quiet before it folds into **Archived**. See [Slack](slack.md). |
| Also owns everything outside every profile's folders | Sessions in folders no profile lists belong to this profile. Only one profile can have it. |

## Worktree per session

Several agents working in one checkout step on each other's changes. With worktrees, a new session
on a git repository gets its own `git worktree` and branch, and runs there instead of the folder
itself. It is off by default.

- **New sessions start in a worktree** sets the profile's default. A folder can override it under
  **Folder options**; the deepest folder that sets it wins. The **New session** dialog shows the
  choice as **Use a worktree**, with a **Branch** field, and you can flip it for one session.
  ⌘/Ctrl+T follows the default and names the branch after the session.
- **Location**: where worktrees go. `${folder}` is the profile folder holding the repository (the
  repository's parent folder when no profile folder holds it), `${repo}` the repository. Empty means
  `${folder}/_worktrees`; each worktree is `<repository>-<branch>`. The `_worktrees` folder is not
  listed as a project. A worktree inside the repository itself is added to the repository's
  `.git/info/exclude`.
- **Branch prefix** goes before every new branch name (`feat/`); **New branches start from** is a
  ref such as `origin/develop`, empty for the repository's default branch. A branch that already
  exists is checked out instead. A new branch has no upstream, so a plain `git push` from the
  session never goes to the branch it started from; push it with `git push -u origin <branch>`.
- Repository hooks run in a session's worktree, as in any checkout you make.
- The session stays in the profile of the folder you started it from, wherever the worktree is.
- Reviewers, resumed sessions and sessions reopened at launch never get a new worktree; a reopened
  session comes back in its worktree.
- **When a session closes**: **Ask whether to remove it** (the default) offers **Close and keep
  worktree** or **Close and remove worktree**. Removing one with uncommitted changes or commits no
  remote has asks again (a repository with no remote at all only asks about uncommitted changes). **Keep it without asking** never offers it. Branches are never deleted.

## Accounts

An account is one sign-in of an agent. Two Claude accounts, for example a personal one and a work
one, keep separate logins, plan limits and history, because each uses its own config folder (for
Claude, something like `~/.claude-work`; Workhub sets `CLAUDE_CONFIG_DIR`, and for Codex
`CODEX_HOME`).

**Settings → Agents and accounts** lists them per agent, one card each: first the agent's
**Sign-in on this computer** (its default folder, used by sessions without an account), then each
account with its agent, its config folder and the variable it sets, and its extras. The account new
sessions of the profile start with has a **Default** badge, and the line above the cards names it.
**Make default** on another card puts that sign-in first in the profile's agent order (and offers the
account in the profile); you can still pick any other one in each new session.

To add a second Claude account, for example a work one next to your personal one:

1. Click **Add account**.
2. Type a name (`Claude work`), keep the agent on Claude and click **Choose…** to pick a folder of
   its own, such as `~/.claude-work` (a new, empty folder is a new login).
3. Leave **Offer in** the profile on, and click **Add account**. The first session with that account
   asks you to sign in.

The id (made from the name), environment variables, command and session defaults are under
**More options**:

| Field | Meaning |
|---|---|
| Agent, Name | The agent the account signs in to, and how it appears in menus and the sidebar. |
| Config folder | Holds this account's login and settings. A different folder is a different account. |
| Offer in the profile | Whether new sessions of the profile being edited can use the account. Other profiles turn it on in **Modules and screens**. |
| Environment variables | Extra variables for this account's sessions, such as `OPENAI_API_KEY` for Codex. The names are saved in the settings; the values are kept encrypted in the secret store (`secrets.json`), never in `config.json`, and the fields are masked. Values saved in `config.json` by an older version move to the secret store the next time Workhub starts. |
| Command | A different executable to run instead of the agent's own command. The agent's arguments are kept. |
| Default model, Default agent or mode | What new sessions of this account start with: a list of what the agent offers, or **Other…** for any id. You can still change them in the session. |

Agents without an account here (Kiro, Codex and so on) are still offered, with their own sign-in.
Kiro has one sign-in per computer (`kiro-cli login`); an account for Kiro only runs it with other
environment variables, another command or other defaults.

The same tab lists **Agents on this computer** (installed or **Not found**, and the engine each
runs on) and **Order and failover** for the active profile.

## Opening links

**Open links with** decides which browser opens the links of this profile (pull requests, tickets
and the rest):

| Choice | Behavior |
|---|---|
| **Default browser** | The system default. |
| **A browser app** | An application name on macOS (for example `Google Chrome`), or the browser's executable elsewhere (for example `chromium`). |
| **Google Chrome with a profile** | Opens a new Chrome window on the **Chrome profile** you pick. **Chrome app** is optional and empty means Google Chrome; set it for another Chrome-based app. If no profiles are found you can type the profile directory (`Default`, `Profile 1`). |
| **Custom command** | An executable (a name on your `PATH` or a full path) that gets the link as its last argument, for example a script that opens a work browser profile. To pass arguments, start with the executable in quotes: `"firefox" -P work` (quote any argument with spaces). Nothing else is interpreted: no variables, pipes or globs. A Workhub 1 opener with arguments is imported in this form. If it fails, the default browser opens the link. |

Slack message links open in the Slack desktop app when it is installed and the workspace is
known (macOS); otherwise they follow the choice above. Only web links are opened.

## Session environment

**Session environment** adds variables to every session started in the profile. Values can use
`${FOLDER}` (the session folder) and `${PROFILE_ROOT}` (the profile's first folder). Values are
stored encrypted and never shown again: a stored value appears as hidden, and typing replaces it.
Names use letters, digits and underscores and cannot start with a digit; an invalid row is ignored.

## Tips

- One profile per context keeps tokens, accounts and notifications apart. The profile colour makes
  the sessions easy to tell apart in the sidebar.
- A session started in a folder that belongs to another profile starts in that profile, with its
  agents.
- **Settings → General** holds the Help and setup entries: **Setup check**, **Welcome tour**
  and **How Workhub works**.

Next: [Sessions](sessions.md).
