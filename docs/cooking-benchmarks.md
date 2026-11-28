# Cooking benchmarks

What the [cooking](user-guide/cooking.md) method costs and what it buys, measured against an agent
working alone and against three other public ways of working. Measured on 27 and 28 November 2026.

Read the [limits](#limits) before quoting a number: one machine, one model, one small repository,
and a harness that is not in this repository yet.

## What was compared

| Name here | What it is |
|---|---|
| **No method** | Claude Code with nothing added |
| **Cooking** | The method of the `workhub-cooking` skill. Two forms were measured: the skill as it ships (one file), and an earlier form with a small command-line helper that kept the job's records |
| **ODD** | gentle-ai 4.6.0, Organic Driven Development, as it installs. Measured with its native review off and on |
| **EGM lite** | The `egm-lite` skill of Google's Elephant-Goldfish Model plugin, commit `4693375` |
| **SDD** | gentle-ai 3.7.0, Spec-Driven Development, a version its authors have since retired. One run per task |

The other methods are named because they are what was measured, each as its authors ship it. They
can be configured in other ways and may then give other results.

## How it was measured

- **Same request, same starting point.** Every method got the same request, word for word, on the
  same commit of the same repository, in a folder of its own.
- **Isolated.** Each run loaded only its own method: no user instructions, skills, plugins, hooks or
  memory from the machine; a private, empty memory store where a method uses one.
- **Same model.** Claude Opus 5.5 as the session's model, through Claude Code 2.1.332. Each method's
  own sub-agents use the models that method names.
- **The user was played by a script.** A director session answered each method from a sheet written
  before the runs, the same for all: approve what the method recommends, the smallest option when it
  recommends none, no commit. It gave no hints.
- **Spend** is what the model provider's list price would charge, in US dollars. It was taken from
  three records that do not depend on each other (the client's telemetry, each session's own total
  and the transcripts) and compared field by field in every run. Processes a method starts by itself
  were measured too.
- **Outcome** was judged two ways: hidden acceptance tests that no agent could see, and a blind
  review. In the blind review a reviewer model received the deliveries under letters, ran the same
  probes on all of them and counted the failures; it marked a defect "must fix" when a person using
  the result would get a wrong answer, lose data or be told something untrue. For the two repeated
  tasks the probes were fixed in advance (11 and 16), so the counts compare across sets.

### The tasks

All on a small command-line tool (about 500 lines, no dependencies) written for the bench.

| Task | Kind |
|---|---|
| Adjacent slots | A light bug: a two-line fix in two places, and a test that contradicts the README |
| Repeated numbers | A bug whose fix must mind files the faulty version already wrote |
| The last hour | A wrong premise: what is asked would break what the README documents |
| Dates | A medium feature: validation and old files that the request does not mention |
| HTTP server | Development from scratch on the existing library, about 400 to 1,000 changed lines |
| Weekly slots | A large change across the model, conflicts, storage and the command line |

## Results

### Did the request get done?

Yes, with every method. All of them passed every hidden acceptance test on every task and every
run. Hidden tests did not separate the methods; the blind review did.

### Was it luck? Two tasks, three runs each

Failures over the fixed probes, per set (fewer is better). In brackets, the "must fix" defects the
reviewer confirmed in that delivery; they include what its own extra probes found, so the number in
brackets can be higher than the failures over the fixed probes.

| Repeated numbers (11 probes) | Set 1 | Set 2 | Set 3 |
|---|---|---|---|
| Cooking (with helper) | 0 (0) | 1 (0) | 0 (0) |
| EGM lite | 1 (1) | 7 (1) | 3 (2) |
| No method | 4 (2) | 4 (1) | 4 (3) |
| ODD | 6 (2) | 7 (1) | 6 (2) |
| ODD, review on | 7 (2) | 7 (1) | 7 (2) |
| SDD (one run) | 3 (1) | | |

| Dates (16 probes) | Set 1 | Set 2 | Set 3 |
|---|---|---|---|
| Cooking (with helper) | 0 (0) | 1 (0) | 2 (1) |
| EGM lite | 1 (1) | 1 (1) | 3 (2) |
| ODD, review on | 1 (1) | 4 (3) | 1 (1) |
| ODD | 4 (3) | 4 (4) | 4 (4) |
| No method | 3 (2) | 5 (4) | 4 (5) |
| SDD (one run) | 2 (1) | | |

The reviewers ranked cooking first in all six sets. In Dates, set 3, it had one more failure over
the fixed probes than ODD with review, and the reviewer still put it first for what the failures
were. "Must fix" defects added over the six runs: cooking 1, EGM lite 8, ODD with review 10, ODD 16,
no method 17.

### The skill as it ships

The shipped skill has no command-line helper: the job's record is the live board and the report.
It was run twice on each of the two tasks above and judged with the same fixed probes, mixed blind
with one earlier delivery of cooking with the helper and one with no method.

| | Shipped skill, run 1 | Shipped skill, run 2 | Cooking with helper | No method |
|---|---|---|---|---|
| Repeated numbers: failures of 11 (must fix) | 0 (0) | 3 (1) | 0 (0) | 4 (2) |
| Dates: failures of 16 (must fix) | 0 (0) | 1 (0) | 2 (1) | 4 (4) |
| Dollars: repeated numbers | 0.90 | 1.04 | 1.17 to 1.39 | 0.18 to 0.20 |
| Dollars: dates | 1.45 | 1.43 | 1.85 to 1.90 | 0.43 to 0.46 |

Without the helper the skill cost about a quarter less and stayed well ahead of no method. One of
its four runs had a "must fix" defect (it warned that a slot's number had changed and then acted in
the same command), so it was a little less even than the form with the helper. All four runs passed
every hidden test. With no Workhub session in the bench, no board was sent; each run said so once.
The two earlier deliveries were judged again here by a new reviewer, so their counts can differ
from the tables above.

### Two large tasks, one run each, two reviewers each

| HTTP server | No method | Cooking | ODD | ODD, review on | EGM lite | SDD |
|---|---|---|---|---|---|---|
| Dollars | 0.62 | 2.44 | 1.86 | 4.35 | 5.61 | 4.38 |
| Messages from the user | 1 | 1 | 1 | 4 | 12 | 5 |
| Changed lines | 426 | 651 | 501 | 612 | 986 | 943 |
| Reviewer 1: rank, must fix | 6th, 1 | 2nd, 0 | 2nd, 0 | 2nd, 0 | 1st, 0 | 5th, 0 |
| Reviewer 2: rank, must fix | 5th, 0 | 2nd, 0 | 4th, 0 | 6th, 0 | 2nd, 0 | 1st, 0 |

| Weekly slots | No method | Cooking | ODD | ODD, review on | EGM lite | SDD |
|---|---|---|---|---|---|---|
| Dollars | 0.75 | 2.52 | 1.33 | 1.27 | 4.43 | 6.65 |
| Messages from the user | 1 | 1 | 1 | 1 | 12 | 4 |
| Changed lines | 372 | 432 | 315 | 316 | 695 | 817 |
| Reviewer 1: rank, must fix | 1st, 0 | 1st, 0 | 5th, 0 | 6th, 0 | 1st, 0 | 4th, 0 |
| Reviewer 2: rank, must fix | 3rd, 0 | 1st, 0 | 4th, 0 | 4th, 0 | 1st, 0 | 6th, 1 |

Ties share a rank. On these two tasks every method delivered something that works and the methods
came out close: with one run each, a difference of one rank says nothing. Cooking and EGM lite had no
"must fix" defect with any of the four reviewers. The two that were found: with no method, the
server stopped on one malformed request; with SDD, a list came out of time order.

### Cost

US dollars per run. The two repeated tasks show their three runs.

| | No method | ODD | Cooking (with helper) | ODD, review on | EGM lite | SDD |
|---|---|---|---|---|---|---|
| Adjacent slots | 0.21 | 0.57 | 0.81 | | 0.98 | 3.12 |
| The last hour (nothing to build) | 0.12 | 0.47 | 0.15 | | 0.34 | 1.01 |
| Repeated numbers | 0.18 · 0.20 · 0.18 | 0.46 · 0.51 · 0.52 | 1.26 · 1.17 · 1.39 | 0.52 · 0.49 · 0.51 | 1.50 · 1.25 · 2.54 | 2.75 |
| Dates | 0.46 · 0.44 · 0.43 | 1.52 · 1.09 · 1.17 | 1.87 · 1.90 · 1.85 | 2.33 · 2.61 · 2.99 | 2.75 · 3.49 · 2.95 | 4.41 |
| HTTP server | 0.62 | 1.86 | 2.44 | 4.35 | 5.61 | 4.38 |
| Weekly slots | 0.75 | 1.33 | 2.52 | 1.27 | 4.43 | 6.65 |

Over the last four tasks, averaging the repeats: no method 2.00, ODD 4.95, cooking 8.11, ODD with
review 8.77, EGM lite 14.87, SDD 18.19.

### How much of the user's attention

Messages the user had to send, over the same four tasks (repeats averaged): no method 4, cooking 4,
ODD 4, ODD with review 9, SDD 18, EGM lite 43. EGM lite moves by gates the user opens one by one; in
three of its eight runs on these tasks it was still in its review-and-fix loop at the cap of twelve
messages.

## What the numbers say

- **Cooking pays where the request leaves things unsaid** that can break: data already stored, edge
  cases, the second time. There the reviewers put it first in every set, at about four times the
  cost of the agent alone.
- **On a fully specified task built from scratch, the methods came out close,** and the agent alone
  did it for a quarter of the cost. The one serious defect found there was in its delivery.
- **Cooking's cost and result were stable from run to run.** EGM lite's cost doubled with the number
  of its review rounds, and its result moved from 1 failure to 7 on the same task.
- **When what was asked would break documented behaviour,** no method, cooking, ODD and EGM lite
  stopped and asked before touching anything. SDD asked how to build it.

## Limits

- **The harness and the raw data are not in this repository yet,** so these numbers cannot be
  reproduced from here. Treat them as one team's measurement.
- **One machine, one model, one small repository.** Another session model or a large codebase may
  change the picture.
- **Few runs.** Three per method on two tasks, one on the others. The large tasks cannot tell luck
  from method.
- **The reviewers are models.** On the HTTP server two reviewers gave different orders. What agrees
  across reviewers and sets is what can be trusted.
- **Cooking had a helper in most runs.** Only the four runs under "The skill as it ships" used the
  skill as it is in this repository.
- **The scripted user follows what each method suggests.** A person would cut EGM lite's review loop
  short, and might answer SDD's questions differently.
- **ODD's native review** runs only when its own risk check asks for it: it did not run on "Repeated
  numbers" or "Weekly slots". Its reviewers are separate processes; here they were pinned to the
  session's model.
- **SDD is a retired version,** run once per task.
- **Time** is left out of the tables: some runs shared the machine with others.
