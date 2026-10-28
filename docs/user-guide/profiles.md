# Profiles

A profile is one context of work, such as a company or a side project. It groups the folders you
work in, the connections it reads from (code host, ticket tracker, chat, Health), the agent
accounts it may use and the optional modules that are on. Switch profiles from the card at the top
of the sidebar. **Manage profiles…** and **Create a profile…** are in the same menu.

Edit profiles in **Settings → Profiles**. Changes are applied with the save bar (**Save**,
**Discard**); leaving with unsaved changes asks first.

## What a profile holds

| Setting | What it does |
|---|---|
| Name, Id | The id is a short permanent identifier (lowercase letters, digits, `.`, `_`, `-`). It cannot be changed after saving. |
| Symbol, Colour | The icon of the profile in the sidebar (default: the first letter of its name) and the colour that marks its sessions down the left edge of their rows. |
| Folders | One per line. New sessions offer them first, and the pull request search falls back to their repositories. |
| Default folder | Where **New session** starts without asking: one of the folders, **Home folder**, or **Another folder…**. Empty means the first folder. |
| Folder options | Per folder: **Only git repos**, and **Each subfolder is its own project** (**Automatic**, **On** or **Off**). With it on, sessions in a subfolder group under a project named after it; Automatic splits this way unless the folder is itself a git repository. |
| Accounts | The agent accounts offered when you start a session in this profile. |
| Agents offered | Which agents appear in the **New session** menu. |
| Agent order | The first agent is the default, and the one Workhub picks on its own (opening a session from a pull request or ticket, asking Claude to review). |
| Connections | At most one connection of each kind: code host, ticket tracker, chat, Health. **None** turns that feature off in this profile. |
| Optional modules | **Health**, **Chat watcher** (the Slack screen) and **Automations**. Off hides their screens. |
| Account failover | **Ask**, **Automatic** or **Off**: what a session does when its Claude account reaches its usage limit or your ceiling. See [Usage and budgets](usage.md). |
| AI review | Settings for the [review before PR](review-before-pr.md) feature. |
| Slack | How long a thread stays quiet before it folds into **Archived**. See [Slack](slack.md). |
| Also owns everything outside every profile's folders | Sessions in folders no profile lists belong to this profile. Only one profile can have it. |

## Accounts

An account is one sign-in of an agent. Two Claude accounts, for example a personal one and a work
one, keep separate logins, plan limits and history, because each uses its own config folder (for
Claude, something like `~/.claude-work`; Workhub sets `CLAUDE_CONFIG_DIR`, and for Codex
`CODEX_HOME`). Add them in **Settings → Agents**:

| Field | Meaning |
|---|---|
| Agent, Name | The agent the account signs in to, and how it appears in menus and the sidebar. |
| Config folder | Holds this account's login and settings. A different folder is a different account. |
| Environment | Extra `KEY=value` lines for this account's sessions, such as `OPENAI_API_KEY` for Codex. |
| Command | A different executable to run instead of the agent's own command. The agent's arguments are kept. |
| Default model, Default agent or mode | What new sessions of this account start with. You can still change them in the session. |

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
| **Custom command** | An executable (a name on your `PATH` or a full path) that gets the link as its only argument, for example a script that opens a work browser profile. If it fails, the default browser opens the link. |

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
- **Settings → Profiles** also holds the Help and setup entries: **Setup check**, **Welcome tour**
  and **How Workhub works**.

Next: [Sessions](sessions.md).
