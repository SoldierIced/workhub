---
name: workhub-automations
description: Read, add and edit the user's Workhub automations and read their past sessions (History) from inside a Workhub session. Trigger: "my automations", "add an automation", "run this every 30 minutes", "change the automation's prompt", "why did the automation fail", "my past sessions", "what did I do yesterday", "find the session where", "mis automatizaciones", "agregá una automatización", "editá la automatización", "historial de sesiones", "qué sesiones tuve".
---

# Workhub automations and history

An **automation** sends a prompt or slash command to a dedicated Workhub session every so often
and/or when a chat message arrives, inside a time window and under rate limits. **History** lists
the past sessions of every agent and account. Inside a Workhub session you reach both through the
local control endpoint. Full reference: "Agents and automations" in
`docs/user-guide/automations.md` of the Workhub repository.

## When to use

- The user asks to list, add or change an automation, or why one failed or waits.
- The user asks about past sessions: what ran yesterday, the session where something was done,
  what an automation's runs did.

## Before calling

When the `workhub` MCP tools are available (`plan_today`, `inbox_list`, `automation_save`,
`history_search`…), use them instead of `curl`: they take the same fields and add the session
and folder themselves. The rules below apply either way.


The session environment has `WORKHUB_SESSION` and either `WORKHUB_SOCKET` (macOS, Linux) or
`WORKHUB_URL` and `WORKHUB_TOKEN` (Windows). With none of them you are not in a Workhub session:
say so and stop; do not look for the endpoint.

```sh
W() {
  if [ -n "$WORKHUB_URL" ]; then # Windows: a loopback port and a token
    local a=() x; for x in "$@"; do a+=("${x/http:\/\/workhub/$WORKHUB_URL}"); done
    curl -s -H "Authorization: Bearer $WORKHUB_TOKEN" "${a[@]}"
  else curl -s --unix-socket "$WORKHUB_SOCKET" "$@"; fi
}
S="session=$WORKHUB_SESSION"
```

Every answer is JSON with `ok`; `ok: false` carries `error`: tell the user in one line. A
read-only (reviewer) session gets `403` on every change.

## Endpoints

| Call | What it does |
|---|---|
| `W "http://workhub/v1/automations?$S"` | The automations of this session's profile and those of every profile: each definition (below) plus `health`, `active`, `startedToday`, `waitReason`, `lastError`, `pausedUntil`, `nextIntervalAt`; and `runs`, the last 20 runs (`outcome`: `ok`, `error`, `rateLimited`, `timeout`, `skipped`, `coalesced`, `stopped`; `detail`, times, `cost`, `tokens`). |
| `W -X POST http://workhub/v1/automations -H 'content-type: application/json' -d @-` | Adds one: `{"session","automation":{...}}`. `name` is required; the rest takes Workhub's defaults. Answer: the automation, off. |
| `W -X PATCH "http://workhub/v1/automations/<id>" -H 'content-type: application/json' -d @-` | Changes the fields sent (`triggers`, `window` and `limits` merge into the stored ones). Answer: the automation, off. |
| `W "http://workhub/v1/history?$S&q=<words>"` | Past sessions, newest first: `agentId`, `agentSessionId`, `title`, `firstPrompt`, `cwd`, `gitBranch`, `lastModified`, `automationId`/`automationName`. Filters: `q` (words in title, prompt, folder, branch), `agent`, `automation` (an id), `folder` (it or below), `limit` (default 30, at most 200). |
| `W "http://workhub/v1/history/<agentId>/<agentSessionId>?$S&limit=50"` | The last messages of one past session: `user` and `agent` text (shortened), `tool` titles, `notice`, `compaction`. Tool output and images are left out. `account=<accountId>` picks one account's copy. |

Automation fields (everything but `id` and `profileId`, which Workhub sets):

```json
{ "session": "<WORKHUB_SESSION>",
  "automation": { "name": "Triage new issues", "prompt": "/triage",
                  "agentKey": "claude", "folder": "~/work/api", "view": "app",
                  "model": "sonnet", "effort": "medium", "permissionMode": "default",
                  "triggers": { "intervalMinutes": 30, "chatChannelIds": [], "prOwner": "" },
                  "window": { "days": [1, 2, 3, 4, 5], "startHour": 9, "endHour": 19 },
                  "limits": { "maxRuns": 6, "perMinutes": 5, "maxPerDay": 60 },
                  "usageThreshold": 85, "sessionPolicy": "reuse", "runTimeoutMinutes": 30,
                  "notify": "failures" } }
```

`agentKey` is `agentId` or `agentId:accountId` of an agent the profile offers (the first one when
left out; copy one from an existing automation). `days` are 0 = Sunday to 6; `sessionPolicy` is
`reuse` or `newEachRun`; `notify` is `failures`, `always` or `never`.

## Rules

- **The user turns it on.** Every automation you add or edit is saved **off**; `enabled: true` is
  refused. Tell the user it waits for them in **Automations** (⌘/Ctrl+5) and say what
  it will do once on (prompt, folder, how often). Sending `enabled: false` turns one off.
- **Ask before editing** an automation the user did not name, and never widen what one may do
  (`permissionMode`, `folder`, `agentKey`) without the user asking for it.
- **Removing one** is done by the user in Automations; there is no endpoint for it.
- **History is read-only.** Ask for `q`, `folder` or `limit` instead of reading everything, and
  read a session's messages only when the user asks about that session.
- **Never print or post secrets** you find in a past session: no tokens, passwords or customer data.
