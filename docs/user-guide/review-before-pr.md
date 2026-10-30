# Review before PR

Workhub has two ways to get a branch reviewed before it reaches your team, plus a way to review
the changes yourself.

## Review before PR: the author briefs a reviewer

The **Review before PR** button in a session's header opens **Review with another agent**.

1. The session's agent (the author) writes a review brief from a prompt: the goal, every
   repository, branch, commit and pull request it touched, how to see each diff, and what to check.
   Workhub never guesses the repositories or diffs; the author knows them. The brief goes between
   `<review-brief>` and `</review-brief>`.
2. The brief goes to the **Reviewer** you pick, in a read-only session next to the author's, with
   the profile's **Reviewer model** and **Reviewer effort** when set. The reviewer is told to treat
   the brief as the author's claim, not as proof: it reads the full diff and every changed file,
   traces the new runtime path through pre-existing code, checks the real identity the code runs
   under, the coverage of each safeguard, the author's "not covered" items, tests, necessity,
   deploy and rollback, hygiene and other open pull requests, then answers a fixed checklist item
   by item. It answers in the profile's review language with an evidence section (files read in
   full, skimmed, not verified), findings ranked **blocker**, **major**, **minor** and **nit**, and
   ends with a `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED` line.
3. If changes are requested, the findings go to the author, which fixes what it agrees with and
   explains what it disputes. Its reply goes back to the reviewer for another round.
4. The loop ends when the reviewer approves (**Approved**), the rounds run out (**Max rounds
   reached**; the reviewer's last findings stay in its chat), you press **Stop loop**, or
   something fails (**Failed**, with the reason).

In the dialog:

| Field | Meaning |
|---|---|
| **Prompt for this session's agent** | Sent as is to the author. Edit or add to it. |
| **Reviewer** | An agent of this profile with a chat. The default is an installed agent of a different kind than the session's own, in the profile's agent order. |
| **Max rounds** | Reviews before the loop stops while the reviewer still requests changes. Default 3. |
| **Send** | Starts the loop. |
| **Review loop instead** | Starts the automatic branch review described below. |

While it runs, both chats show a card with the phase (**Writing the brief**, **Starting the
reviewer**, **Waiting on the reviewer**, **Waiting on the author**), the round, **Stop loop**, and
links between the two sessions (**Open reviewer**, **Open reviewed session**). Stopping or
interrupting a turn of the loop in a chat stops the loop. The author must be idle when you start,
and the session must be in App view.

### The base prompt

The prompt in the dialog starts from a per-profile text. Change the default in **Settings →
Profiles → AI review → Brief prompt for "Review with another agent"**; **Use the default** restores
the built-in one. Keep the instruction to put the brief between the `<review-brief>` markers, or
Workhub sends the whole reply to the reviewer.

## The older review loop

The **review loop** reviews a branch of a git repository on a read-only checkout kept under the data
folder, and sends the findings to the dev session. It can run on its own: when a dev session stays
idle on a branch with commits ahead of its base, the reviewer starts. It never starts on
`main`, `master`, `develop`, `development`, `trunk` or the base branch, and uncommitted changes are
not reviewed. It runs for up to **Rounds before asking you** (default 3), then pauses for you.

The reviewer's prompt carries the commits and the list of changed files, not the code: the diff is
written to `.workhub-review/changes.diff` inside the checkout, and the reviewer reads it and the code
around it from there.

Each round's reviewer chat stays in the sidebar when the round ends, stopped and named after the
branch and round (**Review feat/x · round 2**). The panel says who reviewed (**Reviewed by**: agent,
account and model) and offers **Open reviewer**; the reviewer's chat offers **Open reviewed
session**. The message sent to the dev session names the reviewer too. Close reviewer chats you no
longer need.

When the dev agent fixes a finding it ends its reply with `FIXED F<n>: <what it changed>`. The
finding is marked **Done by the agent**, with what it changed, and stays in the list; the reviewer
checks it in the next round (**Done, verified**) or opens it again. **Request changes** on a done
finding opens it again and sends your note to the dev session (and to the reviewer next round).

Set **Language of the review prompt and messages** to **Español** to get the reviewer's summary and
findings in Spanish.

Each chat has an **Auto review** check in its header, next to **Review before PR**. It is on by
default; turn it off to keep automatic reviews from starting for that session (manual ones still
run). Workhub remembers the choice per session, across restarts. The check shows only when the
profile has **AI review** and **Start automatically** on.

Its panel (**AI review**) shows **Round n of max**, a status (**Reviewing**, **Waiting for
fixes**, **Needs you**, **Ready for PR**, **Failed**, **Stopped**), the reviewer's summary and its
findings by severity with their state (**Open**, **Fixed**, **Disputed**, **Dismissed**). You can
**Continue** (send the open findings to the dev session, allowing one more round if the limit was
reached), **Dismiss selected**, **Review again**, **Stop review**, or write **Your opinion**, which
goes to the dev session now and to the reviewer in the next round. It pauses for you when the
reviewer asks you to decide scope or design, when a finding stays open after two fix attempts, or
when the dev agent disputes a finding. A review is also held when the reviewer's account is past
its usage ceiling (**Run anyway** overrides it).

Settings are per profile, in **Settings → Profiles → AI review**:

| Setting | Meaning |
|---|---|
| **AI review** | On by default. |
| **Start automatically when a dev session goes idle with new commits** | On by default. |
| **Reviewer agent**, **Reviewer model** | Empty uses the first agent in the order and its default model. The model id is the agent's own (Kiro: `claude-opus-5.5`, say). |
| **Reviewer effort** | Optional reasoning effort for the reviewer (`high`, `xhigh`, …). Agents without the setting ignore it. A large model at high effort finds far more in one pass and takes longer (15–20 minutes on a mid-sized change). |
| **Base branch** | The pull request target (default `develop`). If it does not exist, the repository's default branch is used. It is fetched before every round. |
| **Rounds before asking you** | Default 3. |
| **Idle seconds before an automatic review** | Default 60. |
| **Language of the review prompt and messages** | Language of what Workhub sends. |
| **Extra checklist** | One check per line, added to the reviewer's prompt. |

An agent without a read-only permission mode is kept from changing things only by Workhub refusing
its permission requests; prefer an agent with a read-only mode for reviewing.

## Review changes: review it yourself

**Review changes** in the header opens a window with the session's local changes in every repo it
touched. Compare **Branch vs base** (everything since the branch left its base) or **Uncommitted
only**. Pick a file to see its diff, click a line to **Comment on line {n}**, and send all comments
to the agent as one message (**Send {n} comments to {agent}**, or ⌘/Ctrl+Return). **Looks good**
closes the review and tells the session so if you want. If the session is busy, the message is
queued until it is idle. A reviewer session cannot receive comments.

A tool the agent runs can open this window too. Every session (except reviewers) gets
`WORKHUB_SESSION` (its id) and `WORKHUB_SOCKET` (a local socket only your user can reach) in its
environment:

```sh
curl --unix-socket "$WORKHUB_SOCKET" -X POST "http://workhub/v1/sessions/$WORKHUB_SESSION/review" \
  -H 'content-type: application/json' -d '{"repos":[{"path":"/abs/path/to/repo","base":"origin/main"}]}'
```

`repos` is optional: the listed repositories are added to the ones Workhub finds in the session's
folder, and `base` picks the branch to compare with. An open window reloads.

Next: [Pull requests](pull-requests.md).
