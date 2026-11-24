---
name: workhub-board
description: Send a live board to Workhub (shown in this chat's board panel): a JSON document that lets the user follow a job done by several agents while it happens, with stages, a who-asks-whom graph, agents, decisions and a log. Trigger: "live board", "tablero en vivo", "show this job in Workhub", "follow this run in Workhub", "send a board to Workhub".
---

# Workhub live board

A live board is one JSON document that Workhub validates, keeps and draws in the board panel
of the chat that sent it, so the user can follow a job done by several agents while it happens. You send it; you never
write code in Workhub for it. This skill holds the whole format; for more detail and a complete
example, see `docs/user-guide/live-boards.md` and `docs/examples/boards/release.json` in the Workhub
repository (they may not be on this machine).

## When to use

You orchestrate (or report on) a job that several agents do, and the user wants to watch it in
Workhub: its stages, who is working on what, the decisions taken, a log. Not for a single quick
task, and not for a diagram of a business flow measured from APM (that is `workhub-flow-map`).

## Format in short

```json
{
  "format": "workhub.board",
  "version": 1,
  "id": "release-4-3",
  "title": "Release 4.3",
  "status": "live",
  "heartbeatSeconds": 30,
  "blocks": [
    { "type": "steps", "title": "Stages", "steps": [{ "label": "Build", "state": "current" }, { "label": "Deploy", "state": "upcoming" }] },
    { "type": "text", "text": "Waiting for the builders.", "tone": "muted" }
  ]
}
```

- Top level: `format` (exactly `workhub.board`), `version` (exactly `1`), `id`, `title`, `status`
  (`live`, `paused`, `finished`, `failed`), `blocks` (1 to 20); optional `subtitle`,
  `heartbeatSeconds` (whole number 5 to 3600; 60 when absent). `id`: 1 to 100 characters from
  letters, digits, `_`, `.`, `:`, `-`.
- Block kinds: `steps`, `graph`, `list`, `table`, `log`, `text`; their fields are below. Each
  has an optional `title` (up to 120).
- Tones, wherever a `tone` appears: `neutral`, `info`, `good`, `warn`, `bad`, `muted`. A tone is a
  meaning, not a colour.
- Times (`at`) are milliseconds since 1970.
- Strict: a key the format does not know is refused. A document over a limit is refused whole, with
  the field named: Workhub never cuts a text. The whole document may not pass 256 KB.

## Blocks, fields and limits

Besides `type` and the optional `title`, a block has only these fields. Lengths are characters,
counts are items; `?` marks an optional field. An *optional text* sent as an empty string (a block `title`, `subtitle`, a `note`, a `detail`, a `hint`, `empty`, `detailLabel`, an item's `text`) counts as not sent. A *required* text sent empty is refused with `400`: the board `title`, a step, node, item, item-state or column `label`, and the `text` of a text block or of a log entry. An empty table cell is valid and is drawn empty.

| `type` | Fields | Limits |
|---|---|---|
| `steps` | `steps`: `[{ label, state, at? }]`, `note?` | 1 to 30 steps; `label` 1 to 60; `state` is `done`, `current`, `skipped` or `upcoming`; `note` up to 300. |
| `graph` | `nodes`: `[{ id, label, col, row, detail?, hint?, state?, model?, tokens?, startedAt?, endedAt? }]`, `edges?`: `[{ from, to, label?, state? }]` | 1 to 60 nodes; `id` 1 to 60 characters from letters, digits, `_`, `.`, `:`, `-`, unique in the block; `label` 1 to 40 (the agent's name); `detail` up to 60; `hint` up to 300 (a tooltip); `model` up to 40; `tokens` a whole number from 0 (leave it out when unknown, never 0); `startedAt`/`endedAt` times, `endedAt` not before `startedAt` (the box shows the time working); `col` and `row` whole numbers 0 to 11, no two nodes in one cell; node `state` is `idle` (when absent), `active`, `blocked`, `done` or `placeholder`. Up to 120 edges; `from` and `to` are ids of nodes of the block, different from each other; `label` up to 40; edge `state` is `idle`, `flowing` (animated forward) or `returning` (backward, in the `bad` colour). |
| `list` | `items`: `[{ label, id?, agent?, detail?, state?, text?, at? }]`, `empty?` | 0 to 60 items; `id` up to 100 characters, not repeated within the list (an `id` equal to a node id ties the item to that agent); `agent` a node id; `label` 1 to 80; `detail` up to 200; `state` is `{ label, tone?, busy? }` with `label` 1 to 60 and `busy` a boolean (the dot pulses); `text` up to 2000; `at` is drawn as "x minutes ago"; `empty` up to 200, shown when there are no items. |
| `table` | `columns`: `[{ label, width? }]`, `rows`: `[{ cells, tone?, struck?, agent? }]`, `note?` | 1 to 8 columns; `label` 1 to 60; `width` a number 0.5 to 4 (a proportion, 1 when absent). 0 to 100 rows; `cells` is an array of strings, exactly one per column, each up to 500; `struck` is a boolean (struck through and muted); `agent` a node id. `note` up to 600. |
| `log` | `entries`: `[{ at, text, tone?, detail?, agent? }]`, `detailLabel?` | 0 to 300 entries, in any order (drawn newest first); `at` required; `text` 1 to 500; `agent` a node id; `detail: true` entries are hidden until the person ticks a checkbox that appears, labelled `detailLabel` (up to 60) or "Show details". The log has a search box. |
| `text` | `text`, `tone?` | `text` 1 to 2000. |

A board with one block of each of the four kinds that are not shown above:

```json
{
  "format": "workhub.board",
  "version": 1,
  "id": "release-4-3",
  "title": "Release 4.3",
  "status": "live",
  "heartbeatSeconds": 30,
  "blocks": [
    {
      "type": "graph",
      "title": "Who asks whom",
      "nodes": [
        { "id": "lead", "label": "Lead agent", "model": "opus", "tokens": 52000, "startedAt": 1767224000000, "state": "active", "col": 0, "row": 0 },
        { "id": "api", "label": "Builder: api", "detail": "acme-api", "hint": "Owns the pagination fix", "model": "sonnet", "tokens": 18400, "startedAt": 1767224400000, "state": "active", "col": 1, "row": 0 }
      ],
      "edges": [
        { "from": "lead", "to": "api", "label": "task", "state": "flowing" },
        { "from": "api", "to": "lead", "label": "question", "state": "returning" }
      ]
    },
    {
      "type": "table",
      "title": "Decisions",
      "columns": [{ "label": "Decision", "width": 3 }, { "label": "Who" }],
      "rows": [{ "cells": ["Ship together", "Lead agent"], "tone": "good", "agent": "lead" }, { "cells": ["Run the load test", "Lead agent"], "struck": true, "agent": "lead" }],
      "note": "Struck rows were replaced."
    },
    {
      "type": "list",
      "title": "Agents",
      "items": [
        { "id": "api", "label": "Builder: api", "detail": "acme-api", "state": { "label": "working", "tone": "info", "busy": true }, "text": "Fixing the pagination.", "at": 1767224880000 }
      ],
      "empty": "No agents yet."
    },
    {
      "type": "log",
      "title": "Log",
      "entries": [
        { "at": 1767224880000, "text": "api: tests green.", "tone": "good", "agent": "api" },
        { "at": 1767224820000, "text": "api: read src/page.ts", "detail": true, "agent": "api" }
      ],
      "detailLabel": "Show tool calls"
    }
  ]
}
```

A list item `id` and a graph node `id` are references for you; Workhub does not show them.

**Tie entries to agents.** The user can press an agent's box to see only what it did. Give each
list item, table row and log entry the `agent` (the node `id`) it is about, or reuse the node id as
the list item `id`. Without it, Workhub falls back to entries that mention the agent's name and says
it guessed. Send `model`, `tokens` and `startedAt`/`endedAt` on each agent's node when you know them.

**Order:** Workhub draws the blocks in the order you send them; the user cannot reorder them. A good
order: stages, the who-asks-whom graph, the decisions table, the per-agent list, the log.

## Sending it

With the `workhub` MCP tools available, call `board_save` with `{ "board": <the document> }`
instead of `curl`. Otherwise, from inside a Workhub session:

```sh
# macOS and Linux (WORKHUB_SOCKET):
curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/boards \
  -H "X-Workhub-Token: $WORKHUB_SESSION_TOKEN" \
  -H 'content-type: application/json' --data-binary @<board>.json
# Windows (WORKHUB_URL and WORKHUB_TOKEN):
curl -H "Authorization: Bearer $WORKHUB_TOKEN" -H "X-Workhub-Token: $WORKHUB_SESSION_TOKEN" \
  -X POST "$WORKHUB_URL/v1/boards" \
  -H 'content-type: application/json' --data-binary @<board>.json
```

`WORKHUB_SESSION_TOKEN` is this session's own token: without it the post is refused (`401`).
Never print or pass it on. The board lands in the profile of this session and belongs to this
chat: sending the same `id` again from this chat (even after it was restarted or resumed) replaces
it; another chat's board with the same `id` is a different board. On success the answer is
`{"ok":true,"id":"<id>","dropped":[…]}`; `dropped` lists boards of this chat that the cap of 12 removed to make room.

## Rules

1. **Send the whole board each time**, not a patch. The same `id` replaces the board.
2. **While `status` is `live`, send it again at least every `heartbeatSeconds`** (60 s when you
   declare none), unchanged if need be. After more than three heartbeats without news Workhub
   shows "No news since" instead of "Live". Declare a `heartbeatSeconds` you can keep.
3. **At the end, send it once more with `status` set to `finished` or `failed`.** Use `paused`
   when the job waits for the user.
4. Stay under the limits above; shorten the log or the tables before the board reaches 256 KB.
5. **Plain text only**: no HTML, markdown or links; Workhub draws every string as text and shows
   no images. Line breaks are kept in `text`, table cells and list item `text`; labels and titles
   are one line.
6. Never put secrets or customer data in a board.
7. Keep the graph readable: you choose the cells. An edge to a node in a column further right is
   a curve between the facing sides; any other edge runs under the lowest row.

## Answers and what to do

| Answer | Meaning | Do |
|---|---|---|
| `200` | Stored. | Nothing. Keep sending on every change and heartbeat. |
| `400` | The body is not JSON (the answer has only `error`), or breaks the format (`errors` names each field). | Fix the body or the fields named and send the whole board again. If every error is `…: unknown key` on `model`, `tokens`, `startedAt`, `endedAt` or `agent`, this Workhub is older than those keys: drop them and send again. |
| `401` | No session token, or an unknown or revoked one. | You are outside a Workhub session, or the token is wrong. Do not retry; tell the user. |
| `403` | A read-only (reviewer) session cannot send. | Stop; a board must be sent from a normal session. |
| `404` | Unknown session, its profile is gone, or there is no profile. | Stop and tell the user. |
| `409` "Live boards is off…" | Live boards is off for this profile. | **Do not retry.** Tell the user to turn on **Live boards** in **Settings → Profiles → (profile) → Screens**, then send again when they say so. |
| `409` "…already shows 12 live boards…" | 12 boards are live and this `id` is new. | **Do not retry in a loop.** Tell the user; it clears when a board finishes, goes quiet or is removed. If boards of yours are finished, send them with `finished` first. |
| `413` | Over 256 KB. | Shorten the log (fewer entries, shorter text) or the tables, and send again. The `board_save` tool refuses such a board itself, without sending it, with the same text. A client that keeps uploading past 8 MB may get its connection closed and see no answer at all: shorten the board first. |
| `500` | Workhub could not store the board (`{"ok":false,"error":"<message>"}`); nothing was saved. | Send the same board again at the next heartbeat. If it keeps happening, tell the user. |

Never retry a refusal in a loop: only a `400` or a `413` is fixed by changing the board.

## Tell the user afterwards

Say that the board is behind the **Board** button of this chat's bar, its title,
and that it is updated as the job moves. If Live boards was off, say where to turn it on. When
the job ends, say that the board is left as `finished` or `failed`; the user can remove it from the
panel (a board whose tool is still reporting comes back with its next update).
