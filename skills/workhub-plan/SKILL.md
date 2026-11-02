---
name: workhub-plan
description: Read and update the user's Workhub plan (the Plan screen, ⌘9) from inside a Workhub session: today's meetings, the inbox of tasks, bugs and decisions, milestones and people. Trigger: "my tasks", "what's on today", "my meetings", "add to my inbox", "follow-up", "log a decision", "milestone status", "prepare for my next meeting", "mis tareas", "qué tengo hoy", "agregá al inbox".
---

# Workhub plan

Workhub's Plan module keeps the user's meetings (from their calendars), an **inbox** of things to
act on, **milestones** with progress against time and the **people** they meet. Inside a Workhub
session you reach it through the local control endpoint. Full reference: the "Agents and the plan"
section of `docs/user-guide/plan.md` in the Workhub repository.

## When to use

- The user asks what is on today or tomorrow, or to prepare for a meeting.
- The user asks for their tasks, or a task you are working on is in their inbox.
- Something worth remembering came up: a follow-up, a bug you found but will not fix now, a
  decision taken in the conversation.
- The user asks how a milestone is going.

## Before calling

The session environment has `WORKHUB_SESSION` (this session's id) and the endpoint:
`WORKHUB_SOCKET` (a Unix socket, macOS and Linux) or `WORKHUB_URL` and `WORKHUB_TOKEN` (a loopback
port and its token, Windows). Pass the session on every call: the answer is about the profile this
session runs in. With none of them you are not in a Workhub session: say so and stop; do not look
for the endpoint.

`W` works on both (bash, including Git Bash on Windows): it calls `http://workhub/...` over the
socket, or rewrites it to `$WORKHUB_URL` with the token.

```sh
W() {
  if [ -n "$WORKHUB_URL" ]; then # Windows: a loopback port and a token
    local a=() x; for x in "$@"; do a+=("${x/http:\/\/workhub/$WORKHUB_URL}"); done
    curl -s -H "Authorization: Bearer $WORKHUB_TOKEN" "${a[@]}"
  else curl -s --unix-socket "$WORKHUB_SOCKET" "$@"; fi
}
S="session=$WORKHUB_SESSION"
```

From PowerShell use `curl.exe -s -H "Authorization: Bearer $env:WORKHUB_TOKEN" "$env:WORKHUB_URL/v1/..."`.

Every answer is JSON with `ok`. `ok: false` carries `error`: tell the user in one line. An answer
with `enabled: false` or a `reason` means Plan is off in the profile or has no calendar: tell the
user the reason and that it is turned on in **Settings → Plan**.

## Endpoints

| Call | What it does |
|---|---|
| `W "http://workhub/v1/plan/today?$S"` | Today's and tomorrow's events: `title`, `start`/`end` (ISO), `attendees` (`name`, `email`), `organizer`, `meetingUrl`, a short `description`, and `brief` (`phase`, `sessionId`) when a brief was prepared. `state` + `reason` when there is nothing to read. |
| `W "http://workhub/v1/inbox?$S&status=open"` | Inbox items, open ones first. `status`: `open` (default: pending and local), `pending`, `local`, `done`, `discarded`, `ticket`, `all`; also `kind` (`task`, `bug`, `decision`), `area`, `q` (words in title or detail), `limit` (default 50, at most 200). Items have `id`, `kind`, `status`, `title`, `detail` (shortened), `due`, `area`, `criticality`, `people` (names), `ticket`. |
| `W -X POST http://workhub/v1/inbox -H 'content-type: application/json' -d @-` | Proposes items (pending, waiting for the user's approval). Answer: `added` (new ids) and `duplicates` (ids of open items with the same title, which were not added). |
| `W -X PATCH "http://workhub/v1/inbox/<id>" -H 'content-type: application/json' -d '{"session":"'"$WORKHUB_SESSION"'","status":"done"}'` | Changes one item: `status` (`local`, `done`, `discarded`, `pending`), `due` (`YYYY-MM-DD` or null), `area`, `criticality` (or null), `note` (appended to the detail, at most 2000 characters). Answer: the item. |
| `W "http://workhub/v1/milestones?$S"` | Milestones: `name`, `start`, `end`, `status` (`late`, `atRisk`, `onTrack`, `notStarted`, `done`), `progress` and `elapsed` (0–100), `counts` for tracker milestones, `error` when the last count failed. |
| `W -X POST http://workhub/v1/milestones -H 'content-type: application/json' -d @-` | Creates a milestone: `{"session","name","start","end","progress"}` (typed, 0–100) or `"query"` instead of `progress` (counted from the tracker); optional `notes`, `link`, `reason` (a short why, shown to the user). |
| `W -X PATCH "http://workhub/v1/milestones/<id>" -H 'content-type: application/json' -d @-` | Changes `name`, `start`, `end`, `progress` (typed ones), `query` (counted ones), `notes`, `link` (null clears). Include `session` and `reason`. |
| `W -X DELETE "http://workhub/v1/milestones/<id>?$S"` | Deletes a milestone. |
| `W "http://workhub/v1/people?$S"` | People: `name`, `emails`, `handles`. Use it to match meeting attendees and to fill `people`. |

A proposal body (at most 20 items):

```json
{ "session": "<WORKHUB_SESSION>", "source": "Checkout refactor",
  "items": [ { "kind": "task", "title": "Add a retry to the payment callback",
               "detail": "Found while refactoring; out of scope for PAY-123.",
               "people": ["ana@example.com"], "due": "2026-11-10" } ] }
```

`kind` is `task`, `bug` or `decision`; `title` is required (at most 300 characters); `detail`,
`people` (names or emails), `due`, `area`, `criticality` and an http(s) `link` are optional. Add
`"sourceType": "meeting"` for follow-ups of a meeting.

## Rules

- **Propose, do not file.** Put new work in the inbox; never create tracker tickets yourself, and
  never try to approve an item: turning an item into a ticket is the user's action in Workhub.
  Leave `pending` items for the user to review: move one only when the user asks.
- **Offer at the end.** When a task ends, offer in one line to log what came up: follow-ups,
  bugs left for later, decisions taken. Post them only when the user agrees, and list what you
  sent (title and id).
- **Close what you finished.** When you finish work that is a `local` task in the inbox, mark it
  `done` (add a short `note` with the branch or PR when useful). Only touch items the work is
  about; ask before discarding anything.
- **Milestone changes may wait for the user.** A `202` answer with `pending: true` means the
  change is a proposal on the Plan screen, not applied: tell the user it waits for them to apply
  it, and do not send it again. `200` with `applied: true` means it is saved. Change or delete a
  milestone only when the user asks or the work clearly finished it; always send a short `reason`.
- **Keep it short.** One line titles, a detail of a few sentences, no logs or diffs. Ask for
  `limit` and `q` instead of reading the whole inbox.
- **Never print or post secrets**: no tokens, passwords, customer data or private links in
  titles, details or notes. Calendar addresses never leave Workhub; do not look for them.

## Recipes

- **"What's on today?"** Call `plan/today`; list the events by time with title, attendees' names
  and whether there is a call link; mention open inbox items due today (`inbox?status=local`).
- **"Prepare for my next meeting."** Take the next event from `plan/today`. If it has a `brief`
  with a `sessionId`, tell the user a brief exists in that session. Otherwise match attendees with
  `people` and look for open items that involve them (`inbox?q=<name>`), then write a short
  brief: who is coming, what is open with them, what to ask.
- **"Log this decision."** POST one item with `"kind": "decision"` and the reasoning in `detail`.
- **"Mark the beta at 60 %."** `PATCH milestones/<id>` with `progress` and a `reason`; report
  whether it was applied or waits for approval.
- **"How is the beta going?"** Call `milestones`; give status, progress against time gone and,
  for a counted one, done over total.
