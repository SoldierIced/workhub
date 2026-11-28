---
name: workhub-cooking
description: Work on a change with the cooking method, in any git repository: the user asks once, you take and record every product decision, another model reads your plan and then your result, and finished work comes back with each decision and how to change it; the job shows live in this chat's board panel. Trigger: "/cooking", "use the cooking method", "do this with the cooking method", "usá cooking", "método cooking", "hacelo con cooking".
---

# Workhub cooking

A way of doing a change that the user does not have to follow step by step. They ask once and next
see finished work: every product decision taken and written down with how to change it, the plan
read by another model before anything is built, and the result read by a reviewer that saw none of
it. Measured results and what it costs: `docs/cooking-benchmarks.md` in the Workhub repository.

## When to use

The user starts a request with `/cooking`, or asks for the cooking method by name, in any git
repository. Not for a question, an explanation or a review of someone else's work: nothing is
built there. In a reviewer (read-only) session, say it cannot run and stop.

## Size the task first

One bounded look (a handful of reads, no sub-agent), then pick the path. In doubt, the one with
fewer agents: an agent reads about 100k tokens before it is useful, so a piece smaller than that is
cheaper in your hands.

| Size | Path | Sub-agents |
|---|---|---|
| Small: what to change and where is known; it touches no stored data or format, sign-in, secrets, anything others consume, concurrency, install or release; one behaviour with its tests and docs | Short: you write, one reviewer reads the result | 1 |
| Anything else one head can hold (up to about 1,500 changed lines) | One head: one agent reads the contract, you write, one reviewer reads the result | 2, or 3 when a fix needs a new reader |
| Two or more large areas with separate files, each about 500 changed lines or more, or your own context would pass 300k tokens | Cooks: writers in their own copies, then one reviewer of the whole | 6 at most |

Lines and files never decide by themselves. When the task stops being small while you work, say so
and move to the next path from where you are.

## Rules

- **Ask once.** Take every product decision yourself and record it when you take it (see the board).
  Decide from what the project says about itself (README, AGENTS.md, CONTRIBUTING): between two ways,
  the one that keeps what the project already promises; between two that do, the smaller one that
  fulfils the request; between two equally small, the one that looks like what the project already
  does. A limit you accept is a decision too: record it, never leave it as a footnote.
- **Ask only** about what cannot be undone, goes outward (commit, push, publish, a message to
  someone), spends the user's money or quota, or a tie the project's own words do not break and that
  is costly to reverse. One question, in everyday words.
- **If what is asked breaks something the project documents,** say so with the evidence before
  touching anything, and ask.
- **Nothing of the user's outside the repository** is read without their word in this conversation:
  installed programs and their data, home settings, keychains, credentials. That holds for every
  agent you brief.
- **One writer per file.** On the short and one-head paths the writer is you, in the checkout as it
  is. Cooks write in copies of their own (a git worktree each), never in the user's checkout.
- **A reader of a different model than whoever wrote,** when you can choose the model. With Claude:
  Opus for readers, Sonnet for cooks. A reader is read-only and has seen none of the work.
- **Never accept a report on its word:** run the project's checks yourself and read the diff.
- **One read of the result, one read of what the fixes changed, then stop.** What is still open goes
  to the user by name. Findings marked "can wait" never reopen a review: the cheap ones are fixed in
  the same pass, the rest are listed.
- **The agent budget is a limit:** one contract reader (a second read only when the first changed
  stored data or something others consume, never a third), three cooks at most, one reviewer of the
  whole, one more for a fix or its read. No cook for documentation: you write it from the code. An
  agent over the budget needs its reason recorded as a decision first.
- **No commit, push or pull request** unless the user asked.
- **When you cannot start sub-agents,** do the reads yourself as separate passes and say in the
  report that they were not independent. Never present your own read as someone else's.

## Steps

**Short path**

1. Start the job: a short name, and the board (below).
2. Before the first edit, write three lines as the contract: what the user will see; who else it
   must work for (every caller, every way the thing is used, every platform); what it must not lose
   or hide (data already stored, behaviour the project documents). Record the decisions.
3. Write: the test first, seen failing; then the change and the docs that describe it.
4. Run the real thing on a case you build for it (the command, the server, the screen), not only
   the tests. Then the project's checks: typecheck, lint, tests, whichever it has.
5. One reviewer reads the change (brief below). Fix what it marks "fix before merging" from the
   code, not from its summary; it reads what the fix changed.
6. Report.

**One head** adds, between 2 and 3: the contract says what will be built, the shapes that matter
(stored data, anything others consume) and each decision; one reader checks it against the code
(brief below) and what it finds changes the contract or becomes a decision. When the change reads
from outside or keeps data that grows, the contract also says what is stored and what is asked
again, what happens when the service is slow or fails, and the size it will be checked at.

**Cooks** adds: pieces with separate files, each with a brief (below) and a copy of its own;
pieces that depend on each other go in phases (the shared data and shapes first, read by a
reviewer before the next phase); collect each piece yourself (its checks in its copy, then read
its diff, then apply it); then steps 4 to 6 on the whole.

**A request that arrives while a job is open** is added to the job as a piece or queued for after
it: say which. **When the conversation is resumed** (a restart, a new day), send the board again
with the agents that are gone no longer active, and go on from its stages.

**At the end:** when Workhub's review is available (the `workhub-review` skill, `review_open`),
open it on the change; otherwise list the changed files. The work stays uncommitted.

## The board

While the job runs, the user follows it in this chat's board panel. Send one board per job with the
`workhub` MCP tool `board_save` (`{ "board": <the document> }`), or with `curl` as the
`workhub-board` skill shows. Send it when the job starts, at every stage change, right before and
right after each wait for a sub-agent, and when it ends. It travels whole each time.

```json
{
  "format": "workhub.board",
  "version": 1,
  "id": "cooking-repeated-numbers",
  "title": "Cooking: repeated slot numbers",
  "subtitle": "Short path",
  "status": "live",
  "heartbeatSeconds": 1800,
  "blocks": [
    {
      "type": "steps",
      "title": "Stages",
      "steps": [
        { "label": "Size and contract", "state": "done" },
        { "label": "Write", "state": "done" },
        { "label": "Run and check", "state": "current" },
        { "label": "Review", "state": "upcoming" },
        { "label": "Fixes", "state": "upcoming" },
        { "label": "Report", "state": "upcoming" }
      ]
    },
    {
      "type": "list",
      "title": "Decisions",
      "items": [
        {
          "id": "d1",
          "agent": "lead",
          "label": "A file that already has a repeated number is repaired on load",
          "detail": "Why: the user's own file is in that state. Chosen over: failing until fixed by hand.",
          "text": "To change it: remove the repair in the loader; the file is then refused with a message.",
          "state": { "label": "taken", "tone": "info" }
        }
      ],
      "empty": "No decisions yet."
    },
    {
      "type": "table",
      "title": "Checks",
      "columns": [{ "label": "Check", "width": 2 }, { "label": "Result" }, { "label": "Detail", "width": 3 }],
      "rows": [
        { "cells": ["The real command on a built case", "passed", "cancel, add, cancel: the right slot goes"], "tone": "good" },
        { "cells": ["Tests", "running", ""], "tone": "info" }
      ]
    },
    {
      "type": "graph",
      "title": "Who reads whom",
      "nodes": [
        { "id": "lead", "label": "Orchestrator", "detail": "writes", "model": "opus", "state": "active", "col": 0, "row": 0 },
        { "id": "review", "label": "Reviewer", "detail": "reads the change", "model": "opus", "state": "idle", "col": 1, "row": 0 }
      ],
      "edges": [{ "from": "lead", "to": "review", "label": "change", "state": "idle" }]
    },
    {
      "type": "log",
      "title": "Log",
      "entries": [
        { "at": 1767224880000, "text": "Test written and seen failing.", "agent": "lead" },
        { "at": 1767224700000, "text": "Job started: short path.", "agent": "lead" }
      ]
    }
  ]
}
```

- `id`: `cooking-` and the job's name in lowercase ASCII letters, digits and dashes, 60 characters at
  most. One board per job; the same `id` replaces it.
- Decisions: what in `label` (80 characters), why and what it was chosen over in `detail` (200), how
  to change it in `text`. A decision that replaces another keeps the old one, marked as replaced.
- Checks: each with its real result; a failure stays on the board until it passes.
- The graph has one node per agent of the job, with its model; add readers and cooks as they start,
  mark them `done` when they hand in. Each node needs a cell of its own: you at `col` 0, `row` 0, and
  every other agent in `col` 1 on the next free `row` (0 to 11). A node's `label` holds 40 characters
  and its `detail` 60.
- Keep the last 40 log entries.
- `status`: `live` while it runs, `paused` while it waits for the user's answer, `finished` or
  `failed` at the end.
- **The board is never a reason to stop.** An answer that says the document is wrong (`400`, with the
  field it names; `413` when it is over 256 KB: shorten the log) is yours to fix: correct it and send
  again. Anything else (Live boards is off for
  the profile, twelve boards already live, no `board_save` tool, no Workhub session, a refusal, an
  error on Workhub's side): go on without the board and tell the user once in this job, with the
  answer's own text. "Live boards is off" is turned on in Settings → Profiles → Screens.

## Briefs

Fill the braces. A reader's brief never carries your conclusion: it carries the folder and what the
change is meant to do.

**Contract reader**

```text
Review a contract before anything is built, against the checkout at {folder} (HEAD is {base}). Read its
README first, and AGENTS.md when there is one. Nothing the contract describes exists in the code yet.

The contract: {contract}

Read-only: do not edit, create or delete any file, do not commit, do not start sub-agents. You may run
read-only commands. Read nothing of the user's outside that folder.

Look for what is wrong with it, not for what is fine, and check each suspicion against the code:
- Everything it names: does it exist in the code, and is it what the contract takes it for?
- Every promise it makes to the user: what would the code have to read, write or start for it to hold,
  and what does it do today that breaks it?
- What the new thing inherits from what is already there and the contract does not mention.
- Product decisions the user would want to take and are missing: each state, the second time, how it ends.
- The split: does a piece need something only another piece may write?
- What nobody can try on this machine.

Report findings, most severe first, numbered: what the contract says, what the code says (file and
line), and what to change. Mark each "would be built wrong" or "a decision is missing". Say plainly
when nothing turns up. No style preferences.
```

**Reviewer of the change**

```text
Review an uncommitted change in the checkout at {folder} (HEAD is {base}). Read its README first, and
AGENTS.md when there is one. See the change with `git status --short` and `git diff`; new files are
untracked: {new files}.

What the change is meant to do: {the contract}

Read-only: do not edit, create or delete any file, do not commit, do not start sub-agents. You may run
read-only commands and the tests. Read nothing of the user's outside that folder.

Look for what is wrong, not for what is fine, and confirm each suspicion by reading or running it:
- What is left when the step after a change of stored state fails.
- A field that was not sent, as opposed to one sent empty.
- Boundaries: the first and the last, exactly equal, the start and end of a day, beyond a limit; data
  stored before this change existed.
- Text that could mislead; docs and tests that now say something the code does not do.
- The project's own rules (README, AGENTS.md).

Report findings, most severe first: file and line, what is wrong, a concrete case where it fails, and
whether you confirmed it. Mark each "fix before merging" (a person using it gets a wrong result, loses
or exposes something of theirs, or is told something untrue; or a rule of the project is broken) or
"can wait". Say plainly when nothing must be fixed. No style preferences.
```

**A cook's piece**

```text
You are working in the copy at {folder}. Read its README first, and AGENTS.md when there is one. Your
piece is done when the project's checks pass there and you ran the behaviour itself on a real case.

Why: {what the user gets, in two or three sentences}
What is already there: {the names and shapes this piece relies on}
Your part: {numbered and concrete, with file paths}
Not your part, do not touch: {paths}. If the contract gets in your way, say so instead of changing it.

Work only inside that folder. Do not commit, push or open pull requests. Do not start sub-agents.

Report: what you changed, with `git diff --stat` pasted as it is; each check you ran with its real
result; what you did not verify, and why; anything you decided that the reviewer must know.
```

## Report

In the user's language and everyday words: what was built; each check with its real result; the
decisions taken, each with how to change it; what each reader found and what it became; the "can
wait" findings left; anything asked. Say what the job cost when you know it (agents, minutes).
