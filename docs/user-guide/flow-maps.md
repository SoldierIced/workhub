# Flow maps

A flow map is a diagram of one business flow across your services: which service calls which,
which messages cross a queue, where the flow waits. Workhub draws it like an architecture diagram
(lanes, nodes, orthogonal arrows, a replay of the hops) and measures every part from the
environment's APM data: calls, p50, p95, failures, and the same numbers hour by hour, so you see
when each part of the flow got slow.

Nothing about a flow is built into Workhub. A map is a JSON file you (or an agent) write once; the
numbers come from the Health environment you pick.

## Where maps live

`flow-maps/` inside Workhub's data folder, one file per map, named after its `id`. **Settings →
Flow maps** shows the folder, reveals it, imports JSON files into it and lists every map it holds
(an invalid file is listed with its error, and can be deleted from there). The folder is read on
every refresh, so a new or edited file shows up without a restart.

Three ways to add one:

- **Settings → Flow maps → Import JSON…** picks one or more files; each is validated and stored
  under its `id`.
- Drop the file in the folder.
- Post it to the local control endpoint from inside a Workhub session (what the
  `workhub-flow-map` skill does):

  ```sh
  curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/flow-maps \
    -H 'content-type: application/json' --data-binary @checkout.json
  ```

  The answer is `{"ok":true,"id":…,"file":…}` or `{"ok":false,"errors":[…]}` naming the fields.

## Turning it on

Flow maps is an optional module, like Health: **Settings → Flow maps → Flow maps screen** (or
Settings → Profiles → Modules) turns the screen on for the active profile, and it appears in the
sidebar next to Health as **⌘7**. The numbers come from the profile's Health connection and its
environments, so Health has to be set up too; without it the maps are drawn but say so instead
of showing numbers.

## The screen

**Flow maps (⌘7)** shows the Health environments as tabs and, for the chosen one, the maps of the
folder that name it (or name no environment). A map opens with:

- **The toolbar.** The window (6 h, 1 d, 3 d, 7 d); **Diagram** or **Sequence** (the same flow
  as a sequence diagram: one lifeline per service, one arrow per hop in order, or in the order of
  the chosen execution); **Flow** runs a comet along every hop in order, **Still** stops it; zoom in, out and fit to width; **Copy as image** puts the diagram on
  the clipboard as a PNG; **Open in a window** shows the map in a window of its own; **Ask
  Claude** opens a session with the map, its numbers and what is missing already written (and
  not sent); **Refresh** reads the numbers again (never more than every 30 s).
- **One line of verdict.** How many parts are measured, how many have no measure, no APM data
  or failed to read (each a link to the Coverage tab), and the slowest part with its share of
  the flow's time.
- **Today against the usual.** The parts that deviate most from their own seven-day numbers:
  "«orders» is ×2.4 slower than its 7-day usual", or a failure share that grew. Click a name to
  pick the part. Every measure is read with two baselines: the same window right before it
  (yesterday, for a one-day window) and the last seven days.
- **The diagram.** Border colour is the kind of part; a solid arrow is a call that waits, a
  dashed one a message, a red dotted one time waiting in a queue. The label on a hop is its p50.
  The slowest parts get a thicker, warmer outline and the top three a rank badge. A part without
  a measure is faded and dotted; a measured part with no data in the window is hatched. Click a
  part (or its row) to light it up and dim the rest; click the background to clear.
- **Parts.** Every part, slowest first, with calls, calls per minute, p50, p95, p99, failures
  (count and share), its share of the flow's time, and how it compares with the previous window
  and with its seven-day usual (×1.3: a third slower). The picked part shows its result codes
  (`transaction.result`: "HTTP 2xx", "HTTP 4xx"…), both baselines, the hour it was slowest and
  the hour-by-hour chart (bars: calls, line: p95, the slowest hour marked).
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
  once an hour per part (Settings → Notifications → Flow maps turns these off).
- **Legend.** The same explanation, in the app.

Numbers are kept 10 minutes per map, environment and window, like the other details; an
execution is kept 10 minutes too.

## The file

See `docs/examples/flow-maps/checkout.json` for a complete, synthetic example.

| Field | Meaning |
|---|---|
| `version` | `1`. |
| `id`, `name`, `description` | The id names the file (`letters, digits, - _ .`). |
| `environmentId` | Optional: the Health environment the map belongs to; listed under every environment when unset. |
| `phases` | Optional headers over the columns: `{ label, fromColumn, toColumn }`. |
| `lanes` | Rows, top to bottom: `{ id, label, kind }`, `kind: "exception"` draws the lane dashed (external systems, queues). |
| `nodes` | `{ id, lane, label, subtitle?, kind?, column?, note?, measure? }`. Kinds: `app`, `service`, `orchestrator`, `worker`, `queue`, `external`, `datastore` (the colour). The column is computed from the edges when unset: a node sits one column after the farthest node that reaches it. |
| `edges` | `{ from, to, label?, kind?, emphasis?, entry?, measure? }`. Kinds: `sync` (a call that waits), `async` (a message, dashed), `wait` (time in a queue, red). `entry: "top"` enters the target from above instead of from the side, for a hop that would otherwise cross a node. |
| `stages` | Optional checkpoints drawn as chips in `stagesLane` (a saga's steps): `{ id, label, measure? }`. |
| `entry` | Optional: the `apm.transaction` measure that starts the flow, used to list its executions. When unset, the leftmost node with a transaction measure is the entry. |
| `alerts` | Optional limits: `{ "p95Ms": 3000, "errorRate": 0.05, "parts": { "orders": { "p95Ms": 1500 } } }`. `p95Ms` is the p95 in milliseconds, `errorRate` the failure share (0–1); `parts` overrides them per part, keyed by node id, stage id or edge id (`from->to` when the edge has none). A part's own value wins, field by field. |

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
