# Pull requests

The **Pull requests** screen (⌘/Ctrl+2) lists your pull requests and the ones waiting for your
review. Workhub reads them through the GitHub CLI (`gh`) or the GitLab CLI (`glab`) and your own
login: it stores no token for them. GitLab is covered by fixture tests only so far.

## Set up

1. Install `gh` (or `glab`) and sign in: run `gh auth login` in a terminal.
2. In **Settings → Connections**, add a connection of kind **Code host** (GitHub or GitLab) and pick
   it in your profile. Extra options go in the connection's settings, one `key=value` per line; for
   example `scope=org:acme` narrows the GitHub search to an organization.
3. Refresh. If `gh` is missing or signed out, the screen says so and shows the command to run.

The profile's folders are used as a fallback for finding repositories.

## The list

| Filter | Shows |
|---|---|
| **To review** | Pull requests that ask for your review. |
| **Mine** | Your open pull requests. |
| **Stale** | Yours that have been idle for 30 days. |
| **All** | Mine and the ones waiting for you. |

Search by title, author, branch or ticket. The narrowing bar filters by **Status**, **Into** (base
branch), **Repo**, **Author** and **Ticket** (**With ticket** / **Without ticket**), and sets the
**Order of the list** (newest update, oldest update, repository). Each row shows its state: **Draft**,
**Awaiting review**, **Approved**, **Changes requested**, **CI running**, **CI failing**,
**Conflicts**, **Merged** or **Closed**. Tickets in titles and branch names link to the
[Tickets](tickets.md) screen when a tracker is connected.

## The pull request window

Select a pull request to read it in the screen, or open it in its own window (**Open in its own
window**, or **Open in new window** from the row menu). **Open in the browser** uses the browser
chosen for the profile; see [Profiles](profiles.md#opening-links).

| Tab | Contents |
|---|---|
| **Conversation** | Description, reviewers and their state, comments, labels, linked tickets. |
| **Files** | The changed files with their diff, review threads inline, and **Reply** on a thread. Long diffs show the first lines with **Show all**. |
| **Commits** | The commits of the pull request. |
| **Checks** | CI checks and their state. |
| **Slack** | **Followed threads** and **Messages that link it**, with **Track a Slack link**. See [Slack](slack.md). |

Actions on the toolbar:

- **Approve**, **Request changes** and **Comment** submit a review. A comment is required for
  **Request changes**.
- **Open session** opens the session linked to the pull request, or starts one in the matching
  folder.
- **Ask Claude to review** starts a Claude session with a review prompt in the composer; nothing is
  sent until you press **Send**.
- **Close PR…** closes it without merging, with an optional closing comment and an optional **Delete
  the branch**. Long-lived branches are never deleted: the list is **Protected branches** in
  **Settings → General → Pull requests**, and `release…` branches are always kept. A closed pull
  request can be reopened on the code host.
- **Copy link**.

## Notifications

Workhub checks your pull requests every three minutes and shows an OS notification when one changes
or when someone asks for your review. **Settings → General → Pull request notifications** has a
switch per kind: **Review requested**, **Approved**, **Changes requested**, **New comments**, **CI
failed**, **CI passing again**, **Merge conflicts**, **New commits**, **Merged**, **Closed**.
Clicking a notification opens the pull request.

Home shows **My pull requests** and **Waiting for my review**, and the sidebar nav shows how many
wait for your review.

Next: [Tickets](tickets.md).
