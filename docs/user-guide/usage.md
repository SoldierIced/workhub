# Usage and budgets

Workhub shows how much of each plan your agent accounts have used, lets you set ceilings that
keep automatic work under a limit, and tracks token spend per folder.

## Plan usage

Usage cards show, per account, the windows of the plan: Claude's **5h** and weekly windows, Kiro's
credits (used, left and the reset day, plus credits spent per day) and Codex's rate limits. They
appear on Home, in the session monitor and in the menu bar panel. Agents billed by API key (OpenCode,
Codex or Claude on an API key, ACP agents that report a cost) show **API spend**, from what their
sessions report, priced at list prices where only tokens are known.

Where the numbers come from is set in **Settings → Usage → Reading**:

| Switch | Default | What it does |
|---|---|---|
| **Read Claude plan usage per account** | Off | Every 5 minutes, calls an undocumented Anthropic endpoint (the one Claude Code's `/usage` uses) with the account's stored sign-in. It can change or stop working at any time. While it is off, usage comes only from what running sessions report. |
| **Read Codex plan usage per account** | Off | Every 5 minutes, calls an undocumented ChatGPT endpoint with the sign-in in the account's Codex folder, else falls back to the newest limits Codex wrote in its session files. Workhub never refreshes or stores that sign-in. |
| **Read Kiro credits left** | On | Asks `kiro-cli` for its own `/usage`, at most every 15 minutes and only while Workhub is open. Kiro runs briefly in a home folder of Workhub's own, so none of your MCP servers start and no session appears in Kiro's list. |

## Budgets (ceilings)

Under **Settings → Usage → Budgets**, set a ceiling per account and window (**5h ceiling (%)**,
**Weekly ceiling (%)**, **Monthly ceiling (%)**), and a **Warning margin** (points below a ceiling
where the warning starts). Past a ceiling:

- prompts you send from Workhub to that account need **Send anyway** (or **Clear ceiling**);
- automations, Slack wakes and Slack reads on that account wait until the window resets or the
  ceiling is raised or cleared. **Run now** on an automation still runs once;
- a session can continue in another account of the profile, depending on **Account failover**
  (**Ask**, **Automatic**, **Off**) in the profile settings. **Ask** offers it in the chat
  (**Continue in {account}**, **Hand off to {agent}**, **Wait**); **Automatic** switches by itself.

Nothing is installed in the agents: the ceiling lives only in Workhub, and it lets everything
through while the usage is unknown.

**Alerts** notify once per threshold and window, until the window resets. Set **Thresholds (%)**
comma separated, for example `80, 95`.

## Per-session limit

The monitor has **Usage limit for this session**: a ceiling for that one session, per window. It
replaces the account's ceiling for that window, higher or lower (100 lifts it). Past it, prompts
need **Send anyway**. It is kept with the session, also after a restart. **Use the account's
limits** removes it. Usage reading must be on for the agent to set one.

## Token spend

Home's **Token spend by folder** counts fresh tokens (input, cache writes and output) of Claude,
Codex and Kiro in the profile's folders over the last 7 days. It excludes cache reads, which are
re-reads of context that would dwarf everything else. The session monitor lists cache reads
separately as **Context re-read from cache**.

## Reviving an idle conversation

Agents cache the conversation's prompt so each message re-reads it cheaply. The cache lasts a few
minutes (Claude: 5 minutes or 1 hour, renewed by every request). Once it expires, the next message
sends the whole context again at full price: for Claude, 1.25x (5-minute cache) or 2x (1-hour
cache) the input price, against 0.1x or less for a cache read.

The composer warns before that happens:

- **Claude**: Workhub reads the cache lifetime each request asked for from the session's
  transcript, so the notice shows only once the cache has really expired, with the estimated
  cost at list prices next to what a warm cache would cost.
- **Codex and Kiro** report the context size but no cache lifetime: the notice shows after 5
  minutes without activity and says the cache has likely expired, with the context size only.
  Agents that do not report the context size (OpenCode) show no notice.

It shows when the context is at least 20k tokens and, when the cost is known, when a cold resend
costs at least $0.05, so a cheap model's large context does not raise it. It never holds a
message; on a plan subscription the cost is in plan usage rather than money, in the same
proportion.

Next: [Settings](settings.md).
