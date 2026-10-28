# Automations

An automation sends a prompt or slash command to a dedicated session, either when a pull request
message arrives in a Slack channel or on a schedule, inside a time window and under rate limits. Use
it for repeatable chores such as a `/review-prs` skill.

It is an optional module: turn on **Automations** for the profile in **Settings → Profiles**. With
the module off, the profile's automations do not run. The screen is at ⌘/Ctrl+5.

## Create one

**New automation** opens the editor. **Fill from preset → PR reviews from Slack** starts from a
ready-made one that runs on each pull request posted in your review channels.

| Field | Meaning |
|---|---|
| **Name**, **On** | The automation and its switch. |
| **Prompt or slash command** | Typed into the session as is, for example `/review-prs`. |
| **Agent**, **Folder**, **Model**, **Effort** | What runs it and where. |
| **Permissions** | Unattended runs stop at every permission prompt, so pick a mode that lets the skill finish: **Ask permissions**, **Accept edits**, **Plan mode**, **Auto** or **Bypass permissions**. Understand what a mode lets the agent do before using it unattended. |
| **Runs in** | **The chat** or **The console**. |
| **Session** | **Reuse its session** (one dedicated session, resumed when it was closed) or **New session each run** (the new one takes the old one's sidebar place and the Slack threads it listens to). |
| **Run on pull request messages in** | Slack channels that trigger it, and **Only pull requests of (owner)**: a GitHub organization or user (empty accepts any). Channels must also be watched in **Settings → Slack**. |
| **Also every (minutes)** | An optional schedule. Empty means no schedule. |
| **At most (runs)** in **In (minutes)**, **Per day** | Rate limits. |
| **Wait above 5 h usage (%)** | Pauses while the account's usage is that high. |
| **Run timeout (minutes)** | Gives up on a run that takes too long. |
| **Hours** | The window in which it may run. |
| **Only when the skill has pending work** | Reads the skill's JSON **State file** first (no tokens) and starts a run only when something is queued, its head moved, or a claim is older than 60 minutes. |
| **Replies to its Slack messages wake its session** | Off: threads its sessions write in are not followed. |

## Running and watching

Each automation card shows a status (**Off**, **Idle**, **Waiting**, **Paused**, **Failing**,
**Running**), its trigger, how many runs it used of its limits, and why it is waiting (usage over
the guard, past the account's usage ceiling, rate limit, backing off after failures). The actions are
**Run now** (which still runs once when the account is past a ceiling), **Stop**, **Open its session**
and **Edit**.

The **Run log** lists each run with its trigger (**Slack**, **Schedule**, **By hand**) and outcome
(**Done**, **Error**, **Rate limited**, **Timed out**, **Skipped**, **Merged**, **Stopped**), plus what
the run spent. Runs that arrive while one is waiting are merged into it. A Slack event fires an
automation at most once, even across restarts.

Runs of an automation reuse its open session and are grouped in [History](history.md). Sessions an
automation owns are marked in the sidebar.

Automations wait while their account is past a usage ceiling; see
[Usage and budgets](usage.md). Failures notify you if **Automations** is on under **Settings →
General → Other notifications**.

Next: [History](history.md).
