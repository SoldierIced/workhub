# Live boards

A live board lets you follow a job done by several agents while it happens: its stages, who asks
whom, what each agent is doing, the decisions taken and a searchable log. The view is generic.
Nothing about any tool is built into Workhub: a tool running in a Workhub session sends a JSON
document, Workhub checks it, keeps it and draws it, and sends nothing back.

## Turning it on

Live boards is optional and **off by default**. Turn it on per profile with the **Live boards**
switch in **Settings → Profiles → (profile) → Screens**. It has no screen of its own: a board shows in
the chat that sent it.

While it is off for a profile, a tool that sends a board is refused (see
[Answers](#the-endpoint-and-its-answers)) and nothing is stored.

## In the chat

A board belongs to the **chat** that sent it, not to one run of it: when the chat is restarted or
resumed it keeps its boards, and its next update replaces them. Two chats may send boards with the
same id: they are two boards.

- **The button.** A chat that sent boards shows a **Board** button in its bar (**Boards (n)** when it
  sent several; a breathing dot while one is live). It unfolds the board beside the chat, like the
  monitor. Drag the panel's left edge to widen it (double-click puts it back); the width is kept, the
  panel starts closed each time Workhub opens and folds away when the chat has no board left (or
  Live boards is turned off).
- **Several boards.** A chat with several boards picks one at the top of the panel. The panel opens
  on the board whose id arrived first most recently; a board that is sent again does not move up.
  Pick one and the panel stays on it, even when a newer one arrives; if you remove it, the panel
  goes back to the newest. The pick is not kept when you close the app.
- **A closed chat.** Its boards stay stored and come back in the panel when you resume the chat.
  There is no list of every board of the profile.
- **The board's heading** shows its title, a status badge, **Updated** followed by the time it last
  arrived (just the hour for today, with the date for another day) and, when the tool sent one, its
  subtitle.
- **The status** is one of **Live**, **Paused**, **Finished**, **Failed** or **No news since** a time.
  The first four are what the tool said. **No news since** is Workhub's own judgement: a board the
  tool left as live, that has not been sent again for more than three times its `heartbeatSeconds`
  (three minutes when the tool declares none), is not trusted to be live any more. The tool, its
  session or Workhub may be gone. The badge turns by itself while the panel is open, and the next
  update from the tool makes the board **Live** again. A board that is paused, finished or failed
  never turns into **No news since**. When the badge reads **No news since**, the **Updated** time is not
  repeated beside it.
- **Remove** (the bin at the top of the panel) asks first ("Remove “title”?") and deletes the board.
  The question says it: **a board whose tool is still reporting comes back** with its next update, because its chat and
  id are what identify a board.

### Arranging a board and following one agent

None of this reaches the tool or changes the job: it is how the board is drawn on this computer.

- **Boxes of the diagram.** Drag a box, or focus it and use the arrow keys, to move it; the arrows
  follow it. The places are kept per diagram (the 40 diagrams moved last are remembered).
  **Reset layout** puts the boxes back in the cells the tool chose.
- **One agent at a time.** Press a box of the diagram (or focus it and press Enter) to see only what
  that agent did: the other boxes and arrows fade, and the lists, tables and logs keep only its
  entries. **Showing only …** above the blocks says who; its **×**, or pressing the box again, shows
  everyone. An entry belongs to the agent when the tool said so (`agent`, or a list item whose `id`
  is the agent's node id). When a block says nothing of the kind, Workhub keeps the entries that
  name the agent (its name or id as a whole word: `agent3` is not `agent30`), and the block says
  **Entries that mention …** so you know it is a guess. The stages are never filtered.

### What the blocks look like

A board is an ordered list of blocks, drawn in the order the tool sent them, each in a card under
its title. To change the order, change it in the tool. Six kinds exist.

| Block | How it looks |
|---|---|
| `steps` | One slim line: a mark per stage joined by a thin line, and **Stage n of m** at the right. **Done** has a filled check, **current** is bold with a ringed dot, **skipped** is dashed and struck through, **upcoming** is a plain circle. The time of a stage shows when you hover it. A line that does not fit scrolls sideways. An optional note sits under it. |
| `graph` | Boxes and arrows ("who asks whom"), drawn like the Flow maps. Each box shows the agent's name, then its model, the tokens it spent and how long it has worked (each only when the tool sent it: nothing is shown as 0), then its detail line; a coloured bar at its left and a mark tell its state: waiting, working (a breathing dot), blocked, done, or not started (dashed). The time working runs while the board is live and stops at the board's last update otherwise. A node's hint, and anything cut, shows as a tooltip. An arrow is grey when idle, animated forward when flowing, animated backward and red when returning. An arrow label is cut to the room its arrow has and placed where it covers no box and no other label (the arrow's tooltip has all of it). Without a title the diagram is named "Diagram of who asks whom" (numbered, 1, 2 and so on, when a board has several diagrams without a title). A wide diagram is never shrunk until its labels become unreadable: it keeps a minimum width and scrolls sideways. |
| `list` | One row per item: its name (and detail) on the left; its state, with a dot that pulses while it is busy, and its text in the middle; how long ago it was last heard from on the right. An empty list shows the tool's own message or "Nothing here yet". |
| `table` | A header and rows. Column widths are proportions. A struck row is struck through and muted; a row's tone tints it. An empty table shows "Nothing yet". An optional note sits under it. |
| `log` | Time and text, newest first, in a box that scrolls, with a **Search the log** box. When at least one entry is marked as detail, a checkbox appears (**Show details**, or the tool's own label) that shows those entries too (screen readers hear it with the log's title); they are hidden until you tick it. The search matches the text of the entries that are shown. New entries do not move the line you are reading. |
| `text` | A paragraph, coloured by its tone. |

A field sent as an empty string (a `title`, a `subtitle`, a note, a `detail`, a `hint`, an `empty` or a `detailLabel`) is treated as if it had not been sent: nothing is drawn for it, and the default text is used where there is one. This holds only for those optional texts: a required one sent empty (the board `title`, a step, node, item, item-state or column `label`, the `text` of a text block or of a log entry) is refused with 400, and an empty table cell is valid and drawn empty.

Line breaks inside a `text` block, a table cell, a table note or a list item's text are kept; labels
and titles are one line. Tones are drawn with Workhub's own colours.

## Where boards come from

From a tool running **in a Workhub session**. The agent in that session sends the board with the
`workhub-board` skill (turning Live boards on asks which agents get it; Settings → Agents → Workhub
tools installs it too) or with the `board_save`
tool of the `workhub` MCP server. Both reach Workhub's local control endpoint with the session's
own token. The board lands in the profile of that session. If the session has no profile it lands in
the active one.

Workhub never reads the tool's files and never calls the tool: it only shows what the tool sends,
and it knows the tool is still there only because it keeps sending. To start, ask your agent to use
the `workhub-board` skill.

## What it does not do

- No images and no links: every string is drawn as plain text.
- Not on the phone app (Workhub Remote): the boards stay on the desktop.
- No notifications and no tray entry.
- The words inside a board belong to the tool and are not translated. Workhub's own labels (the
  status, the buttons, the search box) are in English and Spanish.
- A board sent to Workhub is not listed under **Changes by agents**: a board is only displayed.

## What is kept, and for how long

- Up to **12 boards per profile**, whatever chat sent them. Sending a board with an id the same chat
  already sent replaces it (also after the chat was restarted or resumed) and does not count against
  the 12; the same id from another chat is another board. A board kept from an earlier version of
  Workhub, before boards belonged to a chat, is not shown anywhere until the first chat that sends its
  id takes it over; it still counts toward the 12 until it goes quiet and can be pushed out.
- A **13th board with a new id** makes room by removing the board that is not live and arrived
  longest ago (finished, failed, paused, or live but with no news; the board that last arrived
  longest ago goes first). It is Workhub's own idea of live: a board with **No news since** can be
  removed this way. **When all 12 are live, the new board is refused** instead, so tools never push
  each other out in a loop. Finish or remove a board, or wait until one has gone quiet.
- Boards are **kept across restarts**. They are part of Workhub's database (`workhub.db`), one row per
  profile, written at most every 5 seconds, so they are in the daily copy in `backups/` too, and
  restoring a copy brings back the boards of that day. They do not expire by age.
- Turning Live boards **off hides the boards and refuses new ones; it deletes nothing.** They are there
  again when you turn it back on.
- Deleting a profile **leaves its boards stored** in the database, like the rest of the app's
  per-profile state; nothing shows them.

## Trying it

`npm run demo` starts the demo app with Live boards on. Open a chat and have it send a board (the
[format](#reference-for-tools-that-send-boards) and an example are below, and in the
`workhub-board` skill): the **Board** button appears in that chat's bar.

## Reference for tools that send boards

The format is strict and versioned. A complete example with every block kind is in
[`docs/examples/boards/release.json`](../examples/boards/release.json).

### The document

| Field | Rule |
|---|---|
| `format` | Required, exactly `"workhub.board"`. |
| `version` | Required, exactly `1`. |
| `id` | Required, 1 to 100 characters from letters, digits, `_`, `.`, `:` and `-`. The board's identity: sending the same `id` again replaces the board. |
| `title` | Required, 1 to 120 characters. |
| `subtitle` | Optional, up to 200 characters. |
| `status` | Required: `live`, `paused`, `finished` or `failed`. |
| `heartbeatSeconds` | Optional whole number from 5 to 3600: how often the tool sends the board while it is live. 60 when absent. |
| `blocks` | Required, 1 to 20 blocks, in the order drawn. |

Every block has a `type` and an optional `title` (up to 120 characters).

### The blocks

Lengths are characters; counts are items. A field marked "optional" may be left out.

**`steps`**: `steps` (1 to 30 items), `note` (optional, up to 300).

| Step field | Rule |
|---|---|
| `label` | 1 to 60. |
| `state` | `done`, `current`, `skipped` or `upcoming`. |
| `at` | Optional time. |

**`graph`**: `nodes` (1 to 60 items), `edges` (optional, up to 120 items).

| Node field | Rule |
|---|---|
| `id` | 1 to 60 characters from letters, digits, `_`, `.`, `:` and `-`; unique in the block. |
| `label` | 1 to 40. |
| `detail` | Optional, up to 60. |
| `hint` | Optional, up to 300; the tooltip. |
| `state` | Optional: `idle`, `active`, `blocked`, `done` or `placeholder`. `idle` when absent. |
| `col`, `row` | Whole numbers from 0 to 11. No two nodes of a block share a cell. |
| `model` | Optional, up to 40: the model the agent runs on, as you name it. |
| `tokens` | Optional whole number from 0: the tokens the agent spent so far. Leave it out when you do not know; never send 0 for unknown. |
| `startedAt`, `endedAt` | Optional times: when the agent started and, once it stopped, when it did. `endedAt` may not be before `startedAt`. |

| Edge field | Rule |
|---|---|
| `from`, `to` | Ids of nodes of the same block, two different ones. |
| `label` | Optional, up to 40. |
| `state` | Optional: `idle`, `flowing` or `returning`. |

**`list`**: `items` (0 to 60 items), `empty` (optional, up to 200; shown when there are no items).

| Item field | Rule |
|---|---|
| `id` | Optional, up to 100 characters. Two items of a list may not share one (items without an `id` are not compared). An `id` equal to a node id of the board's diagram ties the item to that agent. |
| `agent` | Optional node id: the agent the item is about. |
| `label` | 1 to 80. |
| `detail` | Optional, up to 200. |
| `state` | Optional `{ "label": …, "tone": …, "busy": … }`: `label` 1 to 60, `tone` optional, `busy` optional boolean (the dot pulses). |
| `text` | Optional, up to 2000. |
| `at` | Optional time. |

**`table`**: `columns` (1 to 8 items), `rows` (0 to 100 items), `note` (optional, up to 600).

| Field | Rule |
|---|---|
| column `label` | 1 to 60. |
| column `width` | Optional number from 0.5 to 4, a proportion of the table (1 when absent). |
| row `cells` | One string of up to 500 characters per column: no more and no fewer. |
| row `tone` | Optional. |
| row `struck` | Optional boolean. |
| row `agent` | Optional node id: the agent the row is about. |

**`log`**: `entries` (0 to 300 items, in any order; drawn newest first), `detailLabel` (optional, up to 60; the label of the checkbox that shows the `detail` entries).

| Entry field | Rule |
|---|---|
| `at` | Time. Required. |
| `text` | 1 to 500. |
| `tone` | Optional. |
| `detail` | Optional boolean: shown only when the person ticks the checkbox. |
| `agent` | Optional node id: the agent the entry is about. |

**`text`**: `text` (1 to 2000), `tone` (optional).

`at` is a time in milliseconds since 1970 (a positive whole number, like `Date.now()`).

### Tones

Wherever a `tone` appears it is one of `neutral`, `info`, `good`, `warn`, `bad` or `muted`. It is a
meaning, not a colour: Workhub picks the colour. Absent means `neutral`.

### The rules

- **Strict.** A key the format does not know is refused, named in the error (`blocks[0].colour:
  unknown key`), so a typo is not silently ignored.
- **Nothing is cut and nothing is filled in.** A document over a limit is refused whole, with the
  field named (`blocks[2].nodes[1].col: ...`); Workhub never shortens a text.
- **Plain text.** Every string is drawn as text: markup, HTML and links are not interpreted.
- **256 KB.** The document as sent may not pass 256 KB. This is a limit of its own, with its own answer (413).
- **Graph references.** An edge names nodes of its own block, two different ones. Node ids are
  unique within the block. Two nodes may not share a cell.
- **List item ids.** Within a list, an `id` is used at most once.
- **A table row** has exactly as many cells as the table has columns.
- **Newer keys and older Workhub.** `model`, `tokens`, `startedAt` and `endedAt` on a node, and
  `agent` on a list item, a table row or a log entry, are newer than the rest of the format (still
  version 1). A Workhub from before them refuses the whole board with `400` and `<field>: unknown
  key`. A tool that may talk to an older Workhub drops those keys and sends the board again when the
  400 names one of them.

### The endpoint and its answers

`POST /v1/boards` on the local control endpoint, with the document as the body. A tool inside a
Workhub session already has the variables it needs. On macOS and Linux:

```sh
curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/boards \
  -H "X-Workhub-Token: $WORKHUB_SESSION_TOKEN" \
  -H 'content-type: application/json' --data-binary @release.board.json
```

On Windows the session has `WORKHUB_URL` and `WORKHUB_TOKEN` instead of `WORKHUB_SOCKET`: replace
`--unix-socket "$WORKHUB_SOCKET" http://workhub` with
`-H "Authorization: Bearer $WORKHUB_TOKEN" "$WORKHUB_URL"`, and keep the `X-Workhub-Token` header.
The agent tool `board_save` (`{ "board": <the document> }`) does the same without `curl`.

The document never names a profile: the board goes to the profile of the session that owns the
token (the active profile for a session without one).

| Answer | When | Body |
|---|---|---|
| **200** | Stored (or replaced). | `{"ok":true,"id":"<id>","dropped":[]}`; `dropped` lists the ids of boards the cap of 12 removed to make room. |
| **400** | The body is not JSON. | `{"ok":false,"error":"<the JSON parser's message>"}`: only `error`, no `errors` array. |
| **400** | The body is JSON but the document does not follow the format (an empty body counts: it is read as no document). | `{"ok":false,"error":"…","errors":["blocks[2].nodes[1].col: …", …]}`: one entry per problem, each starting with the field; `error` joins them with `; `. |
| **401** | No session token, or an unknown or revoked one; on Windows also a missing or wrong `Authorization` token. | `this needs the session token: send X-Workhub-Token: $WORKHUB_SESSION_TOKEN (changes, History and analytics are refused without it)`, `unknown or revoked session token`, or (Windows) `missing or wrong token: send Authorization: Bearer $WORKHUB_TOKEN`. |
| **403** | The session is read-only (an AI reviewer). | `a read-only (reviewer) session cannot change anything`. |
| **404** | The session is unknown, its profile no longer exists, or there is no profile at all. | `unknown session`, `the profile of this session no longer exists` or `no profile`. |
| **405** | A method other than POST (with a valid session token; without one the answer is 401 first). | `use POST`. |
| **409** | Live boards is off for the profile. | `Live boards is off for this profile: the user turns it on in Settings → Profiles → Screens`. |
| **409** | The profile has 12 live boards and this id is new. | `This profile already shows 12 live boards: one must finish or be removed before a new one can be sent`. |
| **413** | The body is over 256 KB. | `the board is over 256 KB: shorten the log or the tables`. Workhub reads and discards the rest of the upload (up to 8 MB) so the answer always arrives and the connection stays usable. A client that is still sending after 8 MB gets the answer and then has its connection closed (it may see a reset instead of the answer). The `workhub` tool `board_save` does not send a board over 256 KB at all and returns this same text. |
| **500** | Workhub could not store the board (for example the profile's store cannot be opened). | `{"ok":false,"error":"<the error's message>"}`. Nothing was saved or shown. Send the same board again at the next heartbeat; if it keeps happening, tell the user. |

On this route, 409 means only "off" or "full". Do not retry either in a loop: the first needs the
person to turn Live boards on; the second clears only when a board finishes, goes quiet or is removed.

### The heartbeat

Send the **whole board** each time something changes. While `status` is `live`, send it again
**at least every `heartbeatSeconds`** (60 seconds when the board declares none), unchanged if need
be: that is how Workhub knows you are still there. More than three heartbeats without news and the
panel shows **No news since**. When the job ends, send the board once more with `status` set to
`finished` or `failed`: such a board is no longer expected to report. Workhub does not poll the tool.

### How the graph is laid out

The tool picks the cells. A node sits in the cell (`col`, `row`) it names, on a grid of up to
12 columns and 12 rows, and every box has the same size. Workhub places nothing for you and never
moves a node, so arrows may cross a box when the cells are chosen badly.

An arrow to a node in a column further to the right leaves the right side of its source and enters
the left side of its target, as a curve. Any other arrow (to a node in the same column or further
left, the "back to you" arrow) leaves the bottom of its source, runs along its own lane under the
lowest row and comes up into the bottom of its target. An edge's `state` changes its look only.

### A complete small example

```json
{
  "format": "workhub.board",
  "version": 1,
  "id": "release-4-3",
  "title": "Release 4.3",
  "subtitle": "One service, one builder and a reviewer",
  "status": "live",
  "heartbeatSeconds": 30,
  "blocks": [
    {
      "type": "steps",
      "title": "Stages",
      "steps": [
        { "label": "Plan", "state": "done" },
        { "label": "Build", "state": "current" },
        { "label": "Deploy", "state": "upcoming" }
      ]
    },
    {
      "type": "graph",
      "title": "Who asks whom",
      "nodes": [
        { "id": "lead", "label": "Lead agent", "state": "active", "col": 0, "row": 0 },
        { "id": "api", "label": "Builder: api", "detail": "acme-api", "state": "active", "col": 1, "row": 0 }
      ],
      "edges": [
        { "from": "lead", "to": "api", "label": "task", "state": "flowing" },
        { "from": "api", "to": "lead", "label": "question", "state": "returning" }
      ]
    },
    {
      "type": "list",
      "title": "Agents",
      "items": [
        { "id": "api", "label": "Builder: api", "state": { "label": "working", "tone": "info", "busy": true }, "text": "Fixing the pagination.", "at": 1767224880000 }
      ]
    },
    {
      "type": "table",
      "title": "Decisions",
      "columns": [{ "label": "Decision", "width": 3 }, { "label": "Who" }],
      "rows": [{ "cells": ["Ship together", "Lead agent"], "tone": "good" }]
    },
    {
      "type": "log",
      "title": "Log",
      "entries": [{ "at": 1767224880000, "text": "api: tests green.", "tone": "good" }]
    },
    { "type": "text", "text": "Waiting for review.", "tone": "muted" }
  ]
}
```
