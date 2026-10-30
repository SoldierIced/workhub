---
name: workhub-flow-map
description: Write or update a Workhub flow map (the Flow maps screen, ⌘7): a JSON diagram of one business flow across services, measured live from APM. Trigger: "flow map", "mapa de flujo", "map this flow for Workhub", "draw the flow of <feature>", "add a flow to Workhub".
---

# Workhub flow map

A flow map is one JSON file Workhub draws as an architecture diagram and measures from the
environment's Elastic APM data (calls, p50, p95, failures, hour by hour). You write the file; you
never write code in Workhub for it. Full reference: `docs/user-guide/flow-maps.md` in the Workhub
repository; complete example: `docs/examples/flow-maps/checkout.json`.

## When to use

The user wants to see a flow (a payment, an onboarding, a batch) in Workhub, or wants timings per
hop of an existing flow, or asks to fix a map that Workhub lists as invalid.

## Steps

1. **Discover the flow from data, not from memory.** With read access to the APM traces index:
   - find one recent, successful entry transaction (`processor.event: transaction`,
     `service.name`, `transaction.name`);
   - fetch every document of its `trace.id`; link each transaction to the span that called it
     (`parent.id` = the calling span's `span.id`). Transactions are nodes, http/grpc spans are
     `sync` edges, their `span.destination.service.resource` is the edge's measure `destination`;
   - the trace stops at a message broker (the publish span is the last event). The consumer is a
     new trace: find it by a business id in its logs or by `transaction.name` of the consumer
     (`consume <topic>`, `job <name>`), and draw that hop as `async`; time spent in the queue
     is a `wait` edge;
   - services without an APM agent appear only as destinations: draw them as `external` nodes.
   Without data access, ask the user for the trace or the service list; do not invent names.

2. **Write the file.** Rules that keep it readable:
   - 3–6 lanes, top to bottom in flow order: the app or BFF, the orchestration, the domain
     services, then an `exception` lane for external systems and queues;
   - list nodes in flow order (columns are computed from the edges; an edge to an earlier node is
     drawn as a reply and does not move it);
   - one `measure` per node that serves an entry point (`apm.transaction`) and per hop whose
     caller has an APM agent (`apm.span`). Leave the measure out when you are not sure of the
     names: a wrong name shows as "could not read" and hides nothing else;
   - short labels (the node box is 170 px: about 22 monospace characters), the detail in `note`;
   - optional `stages` for a saga's steps, `phases` for the headers over the columns;
   - `environmentId` only when the map applies to one Health environment;
   - `entry`: the transaction that starts the flow, so the screen can list its executions
     (traces). Leave it out when the leftmost measured node is the entry;
   - `alerts` when the user wants to be told: `{ "p95Ms": <about twice the entry's p95 over a
     day>, "errorRate": 0.05 }`, with `parts` for a stricter or looser part. Workhub checks the
     last hour every five minutes and notifies once an hour per part.

3. **Install it.** Inside a Workhub session, post it to the control endpoint; the answer names the
   invalid fields if any:

   ```sh
   curl --unix-socket "$WORKHUB_SOCKET" -X POST http://workhub/v1/flow-maps \
     -H 'content-type: application/json' --data-binary @<map>.json
   ```

   Outside a session, save it as `<data folder>/flow-maps/<id>.json` or hand the file to the user
   for **Settings → Flow maps → Import JSON…**. Then tell the user to open Flow maps (⌘7) → the
   environment → Reload.

4. **Check it.** Open it in Workhub (or ask the user to): the Coverage tab lists what is not
   measured, what APM returned nothing for and what failed. "No data" or "could not read" means a
   wrong `service`, `transaction` or `destination`: verify the exact value in APM (`terms`
   aggregation on the field, filtered by `service.name`) and fix the file. The Executions tab
   lists, for one real trace, the calls the map does not know about ("Seen in the trace, not in
   the map"): add the ones that matter. Posting the same `id` again replaces the file.

## Never

- Put secrets, customer data or anything from a log line in the file: only service, transaction
  and destination names.
- Guess a transaction name from the code: APM's name is what counts (route templates, not paths
  with ids).
- Change Workhub's source to add a map.

## Schema in short

```jsonc
{
  "version": 1,
  "id": "checkout", "name": "Checkout", "description": "…", "environmentId": "prod",
  "entry": { "type": "apm.transaction", "service": "shop-bff", "transaction": "POST /checkout" },
  "phases": [{ "label": "Checkout · sync", "fromColumn": 0, "toColumn": 2 }],
  "lanes": [{ "id": "app", "label": "01 / App" }, { "id": "ex", "label": "EX / External", "kind": "exception" }],
  "nodes": [{ "id": "bff", "lane": "app", "label": "shop-bff", "subtitle": "POST /checkout", "kind": "app",
              "measure": { "type": "apm.transaction", "service": "shop-bff", "transaction": "POST /checkout" } }],
  "edges": [{ "from": "bff", "to": "orders", "label": "place", "kind": "sync", "emphasis": true,
              "measure": { "type": "apm.span", "service": "shop-bff", "destination": "orders:8080" } },
            { "from": "events", "to": "fulfilment", "kind": "wait", "label": "queue" }],
  "stages": [{ "id": "paid", "label": "Paid" }], "stagesLane": "core",
  "alerts": { "p95Ms": 3000, "errorRate": 0.05, "parts": { "orders": { "p95Ms": 1500 } } }
}
```

Node kinds: `app`, `service`, `orchestrator`, `worker`, `queue`, `external`, `datastore`. Edge
kinds: `sync`, `async`, `wait`; `entry: "top"` enters the target from above when the side route
would cross a node.
