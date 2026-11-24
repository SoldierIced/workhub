# Pull requests

The **Pull requests** screen (⌘/Ctrl+2) lists your pull requests and the ones waiting for your
review. Workhub reads them through the GitHub CLI (`gh`) or the GitLab CLI (`glab`) and your own
login: it stores no token for them. GitLab is covered by fixture tests only so far.

## Set up

1. Install `gh` (or `glab`) and sign in: run `gh auth login` in a terminal.
2. In **Settings → Connections**, under **Code**, use **Connect GitHub** (or **Connect GitLab**) and
   pick the connection in your profile. Extra options go in **Edit as text**, one `key=value` per
   line; for example `scope=org:acme` narrows the GitHub search to an organization.
3. Refresh. If `gh` is missing or signed out, the screen says so and shows the command to run.

## Which pull requests a profile shows

Each profile picks its own pull requests in **Settings → Profiles → (profile) → Screens → Pull
requests**, so one login can show only the work organization in one profile and only your own
repositories in another:

| Field | What it does |
|---|---|
| **Organizations or users** | One per line (`acme`, `ana`; a GitLab group such as `acme/team`). Only their repositories are read. |
| **Only these repositories** | One per line, as `owner/repo` (no `*`). Only these are read, and they win over the organizations above. Up to 50. |
| **Hidden repositories** | One per line, as `owner/repo`; `*` stands for any name (`acme/legacy-*`, `acme/*`). Never shown, even when an owner above includes them. |

With only some repositories set, the search reads just those (in a few searches at once when the
list is long). With no owners, the search falls back to the connection's `scope`, then to the repositories of the
profile's folders, then to everything your login sees. Hidden repositories apply in every case.

## The list

| Filter | Shows |
|---|---|
| **To review** | Pull requests that ask for your review. |
| **Mine** | Your open pull requests. |
| **Stale** | Yours that have been idle for 30 days. |
| **All** | Mine and the ones waiting for you. |
| **Merged** | What was merged in a period, with a summary; see [Merged](#merged). |

Search by title, author, branch or ticket. The **Filters** button under it opens a panel that
filters by **Status**, **Into** (base branch), **Repo**, **Author** and **Ticket** (**With ticket** /
**Without ticket**): click an option to turn it on or off (several statuses, branches, repositories
or authors at once; one ticket choice), type in **Filter by…** to narrow the options shown, and read
how many pull requests match at the bottom, next to **Clear**. The button says how many filters are
in use (**Filters · 3**), and each one shows as a chip under it: its **×** removes it, **Clear**
removes them all. Escape or a click outside closes the panel. Beside the button, **Order of the
list** sorts by newest update, oldest update or repository. Each row shows its state: **Draft**,
**Awaiting review**, **Approved**, **Changes requested**, **CI running**, **CI failing**,
**Conflicts**, **Merged** or **Closed**. Tickets in titles and branch names link to the
[Tickets](tickets.md) screen when a tracker is connected.

## Merged

**Merged** lists the pull requests merged in a period and, beside them, a summary of that period.
Nothing is read until you open it; then it reads the last 30 days and keeps the answer for 10
minutes (**Refresh** at the bottom reads again, and a merge made in Workhub makes it read again; GitHub's search can take a minute to list a
new merge). A preset period ends today: coming back on another day moves it.

- **Everyone / Mine**: everyone's pull requests in the profile's scope, or only yours. **Everyone**
  needs a scope: set **Only these repositories** or **Organizations or users** for the profile (or a
  `scope` on the connection, or, on GitHub, folders); without one, only **Mine** is offered, so Workhub never
  reads every merge your login can see.
- **7 days / 30 days / 90 days / Custom…**: the period, up to 366 days; days are local days and weeks
  start on Monday.
- The list groups the pull requests by day, newest first. Each row shows the branch it was merged
  into (**→ develop**), the lines added and removed, and the author. **Filters** narrows the list
  and the summary together: **Into** lists each target branch on its own (`main` and `master` apart),
  plus **release/\*** for every release branch; **Repo**; **Author**. These filters are separate from
  the other lists' and start empty.
- Select a pull request to read it as usual; **Back to summary** or Esc returns to the summary.

The summary shows how many were merged (and the change against the previous period of the same
length), lines added and removed, files changed, and the median time from opening to merge; a chart
per day or week, stacked by target branch (**main**, **master**, **release/\***, **develop**, **Other**),
with **Table** for the same numbers; and tables by target branch and by repository.

GitHub answers at most 1,000 results per search, so Workhub splits long periods into smaller
searches and stops at the newest 3,000 merges; the summary says so when it stopped there, and the
comparison with the previous period is then left out. GitLab does not report lines or files in its
lists, so those show as not reported. Merged is not on the phone.

## The pull request window

Select a pull request to read it in the screen, or open it in its own window (**Open in its own
window**, or **Open in new window** from the row menu). **Open in the browser** uses the browser
chosen for the profile; see [Profiles](profiles.md#opening-links).

| Tab | Contents |
|---|---|
| **Conversation** | Description, reviewers and their state, comments, labels, linked tickets. |
| **Files** | The changed files with their diff, review threads inline, and **Reply** on a thread. Long diffs show the first lines with **Show all**. The diff loads after the rest of the pull request, so the other tabs are ready first; the tab says **Loading files…** meanwhile, and an error here has its own **Retry**. |
| **Commits** | The commits of the pull request. |
| **Checks** | CI checks and their state. |
| **Slack** | **Followed threads** and **Messages that link it**, with **Track a Slack link**. See [Slack](slack.md). |

A pull request you already opened shows again at once from what Workhub kept, and is read again in
the background (up to 30 are kept per profile; switching profiles forgets the others). If that
read fails, the last copy stays with a quiet line that says how old it is. **Refresh** always asks
the code host again. Workhub checks who you are signed in as once and again every 10 minutes, not
before every read; before approving, sending back or closing it asks again, so switching accounts
in `gh` counts at once.

Actions on the toolbar:

- **Approve**, **Request changes** and **Comment** submit a review. A comment is required for
  **Request changes**.
- **Open session** opens the session linked to the pull request, or starts one in the matching
  folder.
- **Ask Claude to review** starts a Claude session with a review prompt in the composer; nothing is
  sent until you press **Send**.
- **Fix CI** (when CI failed) and **Address review comments** (when there are unresolved review
  threads or a reviewer asked for changes) send a prompt to the session linked to the pull request:
  the failing checks with their links, or the review comments with their file and line, quoted as
  data written on the code host, and a request to fix or address them on the pull request's branch
  without pushing until you agree. With no linked session, Workhub asks before it starts one in the
  profile folder that holds the pull request's repository (preferably one already on its branch)
  and sends the prompt there. Nothing is sent without your click. The same buttons show on the
  pull request rows of a session's monitor, where they send to that session (there, **Address
  review comments** shows when a reviewer asked for changes).
- **Close PR…** closes it without merging, with an optional closing comment and an optional **Delete
  the branch**. Long-lived branches are never deleted: the list is **Protected branches** in
  **Settings → Connections → Code**, and `release…` branches are always kept. A closed pull
  request can be reopened on the code host.
- **Merge…** merges it now. It is enabled only while the pull request is open, not a draft, and
  the code host reports it as mergeable. The dialog offers the methods the repository allows
  (**Merge commit**, **Squash and merge**, **Rebase and merge** on GitHub; on GitLab the project's
  own method, with squashing as its squash option allows) and **Delete the branch**, locked for
  protected branches as above. The confirmation names the method and whether the branch is
  deleted. When the code host refuses (conflicts, failing or unfinished required checks, no
  permission), the dialog says which. After a merge, sessions working in a worktree on the
  pull request's branch are offered to close with their worktree removed; nothing happens until
  you click, and a worktree with uncommitted or unpushed work is kept.
- **Copy link**.

When the code host confirms an action, the dialog closes at once and the screen shows the result
before the next read: an approved, sent-back or reviewed pull request leaves **To review**, a merged
one shows **Merged** and a closed one **Closed**. That holds for up to two minutes, or until the
code host reports a newer change to the pull request; a failed read never undoes it. Both the
pull request and the list are then read again in the background, in every open window.

## Create a pull request from a session

When a session's branch is pushed, has commits beyond the base and has no open pull request, the
session monitor shows **New pull request** with **Create pull request…**. The form starts with the
first commit's subject as the title, the review brief as the description when **Review before PR**
produced one, and the remote's default branch as the base; **Open as a draft** is off. Nothing is
sent until you press **Create pull request**; the new pull request then opens in its own window.

Workhub never pushes a branch. If the remote does not have the branch, or lacks some of its
commits, the monitor says so and shows the push command with **Copy**.

## Notifications

Workhub checks your pull requests every three minutes and shows an OS notification when one changes
or when someone asks for your review. **Refresh every**, in the code host connection (**Settings →
Connections → Code**), changes how often: from 1 to 60 minutes. The lists on screen follow it too. **Settings → Notifications and alerts** (Pull requests) has a
switch per kind: **Review requested**, **Approved**, **Changes requested**, **New comments**, **CI
failed**, **CI passing again**, **Merge conflicts**, **New commits**, **Merged**, **Closed**.
Clicking a notification opens the pull request.

Home shows **My pull requests** and **Waiting for my review**, and the sidebar nav shows how many
wait for your review.

Next: [Tickets](tickets.md).
