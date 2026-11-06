# Flow maps

A flow map is a diagram of one business flow across your services: which service calls which,
which messages cross a queue, where the flow waits. Workhub draws it like an architecture diagram
(lanes, nodes, orthogonal arrows, a replay of the hops) and measures every part from the
environment's APM data: calls, p50, p95, failures, and the same numbers hour by hour, so you see
when each part of the flow got slow.

Nothing about a flow is built into Workhub. A map is a JSON file you (or an agent) write once; the
numbers come from the Health environment you pick.

## Where maps live

`flow-maps/` inside Workhub's data folder, one file per map, named after its `id`. **Settings → Profiles → (profile) → Screens →
Flow maps** (open the row) shows the folder, reveals it, imports JSON files into it and lists every map it holds
(an invalid file is listed with its error, and can be deleted from there). The folder is read on
every refresh, so a new or edited file shows up without a restart.

Three ways to add one:

- **Settings → Profiles → (profile) → Screens → Flow maps → Import JSON…** picks one or more files; each is validated and stored
  under its `id`.
- Drop the file in the folder.
- Post it to the local control endpoint from inside a Workhub session (what the
  `workhub-flow-map` skill does):

  ```sh
  curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/flow-maps \
    -H 'content-type: application/json' --data-binary @checkout.json
  ```

On Windows the session has `WORKHUB_URL` and `WORKHUB_TOKEN` instead of `WORKHUB_SOCKET` (a loopback
port with a token made at each launch): replace `--unix-socket "$WORKHUB_SOCKET" http://workhub` with
`-H "Authorization: Bearer $WORKHUB_TOKEN" "$WORKHUB_URL"` in these examples.

  The answer is `{"ok":true,"id":…,"file":…}` or `{"ok":false,"errors":[…]}` naming the fields.
  A posted map replaces the stored one with the same `id`; when the posted file has no `alerts`,
  the stored map's `alerts` are kept, so an agent that redraws a map does not drop its limits.

## Turning it on

Flow maps is an optional module, like Health: the **Flow maps** switch in
**Settings → Profiles → (profile) → Screens** turns the screen on for that profile, and it appears in the
sidebar next to Health as **⌘7**. The numbers come from the profile's Health connection and its
environments, so Health has to be set up too; without it the maps are drawn but say so instead
of showing numbers.

## The screen

**Flow maps (⌘7)** has one header row: the title, the Health environments as a segmented control
(a dot for each one's state; hover it for the label), and **Reload** (reads the folder and the
opened map again) and **Settings** (Settings → Profiles → (profile) → Screens → Flow maps) at the right.

The left rail lists the maps of the folder that name the chosen environment (or name none): under
their `group` heading (maps without one under **Other**, last), with a search box that matches name,
heading and description (accents and case ignored). The dot next to each map says how it stands in
the last stored hour: red when a part is over the map's limits, green when none is, grey without
limits or without data yet; a red count next to it says how many parts are over. The dots and
counts come from the local history only: listing the maps never reads the cluster.

The map picked opens next to the rail with:

- **The map header.** The name and description; the window (6 h, 1 d, 3 d, 7 d); **Diagram** or
  **Sequence** (the same flow as a sequence diagram: one lifeline per service, one arrow per hop
  in order, or in the order of the chosen execution); the animation button (a comet runs along
  every hop in order; press it again to stop); **Fit to width**; a **⋯** menu with zoom in, zoom
  out, **Copy as image** (the diagram on the clipboard as a PNG) and **Open in a window** (the map
  in a window of its own); **Ask Claude** opens a session with the map, its numbers and what is
  missing already written (and not sent); the last button reads the numbers again (never more
  than every 30 s).
- **Four verdict tiles.** **Coverage**: how many parts are measured, and a link to the Coverage
  tab with how many have no measure, no APM data or failed to read. **Slowest part**: its name
  (click to pick it), p95 and share of the flow's time. **Alerts**: how many parts are over their
  limits in the window (red when any; click for the Alerts tab). **Against the usual**: how many
  parts deviate from their own seven-day numbers, and the worst one ("«orders» is ×2.4 slower than
  its 7-day usual", or a failure share that grew); click it to pick the part. Every measure is
  read with two baselines: the same window right before it (yesterday, for a one-day window) and
  the last seven days.
- **The diagram.** Fitted to the width of its box. Border colour is the kind of part; a solid
  arrow is a call that waits, a dashed one a message, a red dotted one time waiting in a queue.
  The label on a hop is its p50. The slowest parts get a thicker, warmer outline and the top
  three a rank badge. A part without a measure is faded and dotted; a measured part with no data
  in the window is hatched. Click a part (or its row, or focus it with Tab and press Enter) to
  light it up and dim the rest; click the background to clear. The Sequence view fits its
  lifelines to the width too, and scrolls sideways only past eight services.
- **The detail drawer.** Beside the diagram, the picked part: its kind, its rank and share, calls,
  p50 / p95, failures, calls per minute, how it compares with the previous window and with its
  seven-day usual (×1.3: a third slower; hover for the baseline's numbers), the hour-by-hour chart
  (bars: calls, line: p95, the slowest hour marked), its result codes (`transaction.result`:
  "HTTP 2xx", "HTTP 4xx"…), its limits with the ones exceeded flagged (**adjust** opens Settings → Profiles → (profile) → Screens →
  Flow maps), and **Investigate this part**, which opens the Ask Claude draft focused on it. The
  chevron folds the drawer; Workhub remembers it, and starts it folded when the screen is narrower
  than 1200 px.
- **Parts.** Every part, slowest first, with calls, calls per minute, p50, p95, p99, failures
  (count and share), its share of the flow's time, and how it compares with the previous window
  and with its seven-day usual. Picking a row picks the part in the diagram and the drawer.
- **Executions.** The real executions of the flow: the APM traces of its entry transaction,
  latest, slowest or failed only. Pick one and the diagram shows what each part took in it
  (and when it started), parts it never touched fade, and a waterfall lists the hops on one time
  axis. **Seen in the trace, not in the map** lists the transactions and outgoing calls of that
  execution that no part measures: the candidates to add. **Logs** lists, under the waterfall,
  the APM errors of that trace and the container log lines that carry its trace id, in order,
  with the service and the level. Ask Claude passes them along.
- **Coverage.** The parts without a measure, the measured ones APM returned nothing for (a name
  that differs from what APM records, or a part nothing called), and failed reads.
- **Alerts.** Every measured part with its limits (`alerts` in the file), its current p95 and
  failure share, and whether it is above a limit. While the module is on, Workhub reads every
  map that has limits every five minutes over the last hour and notifies the parts above them,
  once an hour per part (Settings → Notifications → Flow maps turns these off; a map's own
  **Notify** switch in Settings → Alerts turns off only that map). A part with fewer calls in the
  window than the map's minimum (default 20) is never over a limit. **Settings → Alerts → Flow
  maps · limits** edits the limits of every map without opening its file: see below.
- **Legend.** The same explanation, in the app.

Without Health (the module off, or not set up yet) the maps are still listed and drawn, without
numbers: a badge in the header says so, and the tiles and the drawer say "no numbers" with a link
to turn Health on. Without the Flow maps module the screen only says how to turn it on.

### Editing the limits in Settings

**Settings → Alerts → Flow maps · limits** lists every valid map of the folder under its `group`,
with the environment that measures it. Per map: a row for every part (p95 in ms, failure share in
%, and the map's **Notify** switch), one row per part with limits of its own (pick a measured part
and **Add part limit**; a blank field inherits the map's value), and **Minimum calls**. **Now**
shows the last stored hour (no cluster read) against the limits as typed: *ok*, *over p95* or
*over failures*. **Save limits** writes the `alerts` field into the map's file: the map is
validated first, and every other byte of the file stays as it was.

### Local history

The numbers come from a local history, so a map draws at once and the cluster is read as little
as possible. Workhub keeps, per environment and measure, one aggregate per hour for the last seven
days: calls, failures, the result codes and a latency histogram (buckets 20% wide, 1 ms to
10 minutes, so a percentile is within about 10% of what APM would say). Every window (1 h to 7 d),
its previous window and the seven-day baseline are added up from those hours. A window is that
many whole hours plus the part of the hour in course already gone, so it is never shorter than
its name: the 1 h window read at 10:20 covers 9:00 to 10:20, and calls per minute are counted
over those 80 minutes. The previous window is the same number of whole hours just before it.

- Opening a map draws the stored numbers right away, then reads only the hours not stored as
  final: the first time a measure is seen that is the whole week, after that the hour in course
  and the one before (an hour counts as final 15 minutes after it ends, as APM documents arrive
  late).
- A measure is read again at most every two minutes (**Refresh**: every 30 s), and two maps that
  measure the same thing share it. At most four reads run against the cluster at once, the alert
  checks included.
- If a read fails, the stored numbers stay on screen and a message says why they are not newer.
- The history lives in `flow-history/` in the data folder, one file per profile, connection and
  environment (about 10 MB for a few hundred measures). Hours older than seven days are dropped,
  and a file not written for seven days is deleted.

An execution is kept 10 minutes.

## The file

See `docs/examples/flow-maps/checkout.json` for a complete, synthetic example.

| Field | Meaning |
|---|---|
| `version` | `1`. |
| `id`, `name`, `description` | The id names the file (`letters, digits, - _ .`). |
| `group` | Optional: the heading the map is listed under, such as `Payments` (up to 40 characters). |
| `environmentId` | Optional: the Health environment the map belongs to; listed under every environment when unset. |
| `phases` | Optional headers over the columns: `{ label, fromColumn, toColumn }`. |
| `lanes` | Rows, top to bottom: `{ id, label, kind }`, `kind: "exception"` draws the lane dashed (external systems, queues). |
| `nodes` | `{ id, lane, label, subtitle?, kind?, column?, note?, measure? }`. Kinds: `app`, `service`, `orchestrator`, `worker`, `queue`, `external`, `datastore` (the colour). The column is computed from the edges when unset: a node sits one column after the farthest node that reaches it. |
| `edges` | `{ from, to, label?, kind?, emphasis?, entry?, measure? }`. Kinds: `sync` (a call that waits), `async` (a message, dashed), `wait` (time in a queue, red). `entry: "top"` enters the target from above instead of from the side, for a hop that would otherwise cross a node. |
| `stages` | Optional checkpoints drawn as chips in `stagesLane` (a saga's steps): `{ id, label, measure? }`. |
| `entry` | Optional: the `apm.transaction` measure that starts the flow, used to list its executions. When unset, the leftmost node with a transaction measure is the entry. |
| `alerts` | Optional limits: `{ "p95Ms": 3000, "errorRate": 0.05, "minCalls": 20, "parts": { "orders": { "p95Ms": 1500 } } }`. `p95Ms` is the p95 in milliseconds, `errorRate` the failure share (0–1); `parts` overrides them per part, keyed by node id, stage id or edge id (`from->to` when the edge has none). A part's own value wins, field by field. `minCalls` (default 20): a part with fewer calls in the window breaks no limit. `notify: false` keeps the limits on screen without notifying. |

A `measure` says how a number is read from APM:

- `{ "type": "apm.transaction", "service": "orders", "transaction": "POST /orders" }`: the
  duration of an entry point (an HTTP route, a gRPC method, a consumer), with its failure share.
  Put it on the node that serves it, or on a stage.
- `{ "type": "apm.span", "service": "shop-bff", "destination": "orders:8080" }`: the duration of
  the outgoing calls of a service to a destination (`span.destination.service.resource` in APM).
  Put it on the edge.

Parts without a measure are drawn but not measured. A measure that fails (a wrong name, a
missing index) is reported on its row, the rest still reads.

### Finding the names

The names are the ones APM reports: `service.name`, `transaction.name` and
`span.destination.service.resource` of the traces index configured for the environment. Kibana's
APM app shows them per service (Transactions, Dependencies), and the **Slow endpoints** card of
Health lists transaction names. An agent with read access to Elasticsearch can derive a whole map
from one trace: follow `trace.id` and `parent.id` across the transactions and spans of one request
(the `workhub-flow-map` skill explains how).
