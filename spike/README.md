# Workhub 2 - P0 spike

> Historical. This spike is finished and kept only as a reference for the stack and ACP findings below. It is not part of the workspaces and is not maintained; the app lives in `packages/`.

Throwaway spike that proves the stack (Electron + electron-vite + React + strict TypeScript,
xterm.js + node-pty, ACP client) on macOS and answers two open MCP questions.

## Run

```
npm install          # postinstall downloads the Electron binary and rebuilds node-pty for Electron
npm run dev          # app with two tabs: Terminal, ACP chat
npm run typecheck
npm run build
npx tsx probe/acp-probe.ts kiro     # headless probe, raw log in probe/out/kiro.jsonl
npx tsx probe/acp-probe.ts claude   # raw log in probe/out/claude.jsonl
```

For scripted smoke tests: `npm run dev -- --remote-debugging-port=9222`, then
`node scripts/drive.mjs '<json steps>'` (CDP: eval, type, key, shot).

## Versions

electron 45.0.0, electron-vite 6.0.0, vite 8.3.5, react 19.3.1, typescript 7.0.2, node-pty 1.1.0,
@xterm/xterm 6.0.0, @xterm/addon-fit 0.11.0, @electron/rebuild 4.2.1,
@agentclientprotocol/sdk 2.0.2 (official ACP TS library), @agentclientprotocol/claude-agent-acp 0.97.0
(the old `@zed-industries/claude-agent-acp` is deprecated and renamed to this).

## What was proven (macOS)

- Terminal tab: login shell via node-pty in a chosen folder, typing and resize work (`echo hi`, `stty size` changed on resize).
- ACP chat tab: Kiro (`kiro-cli acp`) and Claude (`npx --no-install claude-agent-acp`) both do
  initialize + session/new + prompt, streaming message chunks and tool-call updates.
- Agents are spawned in Electron main; the renderer only sees the typed `window.hub` preload bridge
  (contextIsolation on, nodeIntegration off, sandbox on).
- Not exercised live: the Allow/Deny permission buttons. Kiro auto-trusted the tools used and the Claude
  adapter started in `bypassPermissions` (inherited from the user's settings), so no request was ever sent.
  The code path exists but is untested.

## Q1: does the Claude ACP adapter load the user's ~/.claude MCP servers with an empty mcpServers list?

Yes, fully. With `mcpServers: []` the agent reported every MCP server of the user's own Claude Code
setup, plus the claude.ai connectors, and listed the ones still waiting for authorization. It also loaded user hooks (the answer quoted a
`UserPromptSubmit` hook), skills/agents (session `configOptions` has an `agent` option with the user's
agents), and `bypassPermissions` as the default mode. So the adapter runs the full Claude Code settings stack.
Evidence: `probe/out/claude.stdout.txt` ("streamed answer"), `probe/out/claude.jsonl`.
Consequence: Workhub cannot treat ACP-Claude as an isolated MCP environment, but there are no MCP
status/reconnect/toggle controls either (D8 stands: Claude goes through the native Agent SDK).

## Q2: what MCP information does Kiro expose over ACP?

- Standard: `agentCapabilities.mcpCapabilities = {http: true, sse: false}`; `session/new` takes `mcpServers`.
- Kiro also loads its own `~/.kiro` MCP config when `mcpServers` is empty (
  every server configured there).
- Extension notifications (`_kiro.dev/...`, no `_meta` on initialize):
  - `_kiro.dev/mcp/server_initialized {sessionId, serverName}` per server.
  - `_kiro.dev/mcp/oauth_request {sessionId, serverName, oauthUrl}` for servers needing OAuth.
  - `_kiro.dev/commands/available {commands[25], mcpServers[{name,status,toolCount}], prompts, tools}`: live
    server list with status (`running`/`loading`) and tool counts, plus all tool schemas. This is the MCP status feed.
  - `_kiro.dev/metadata {contextUsagePercentage, meteringUsage:[{value, unit:"credit"}], turnDurationMs, reasoning}`.
  - `_kiro.dev/subagent/list_update`.
- Slash commands include `/mcp` (list, add, remove), `/usage`, `/model`, `/context`, `/tools`.
  Their options go through extension methods such as `_kiro.dev/commands/agent/options`; the probe did not call them.
- Gap: no ACP-level reconnect/toggle was observed; control likely goes through the `/mcp` slash command.

## Other findings

- Claude adapter: `usage_update {used, size, cost{amount,currency}}`, `session_info_update {title}`, prompt result
  carries `usage` token counts and `_meta.quota` per model, `available_commands_update` (125 commands),
  `configOptions` (mode, model, effort, fast, ultracode, agent). Kiro: `modes` (agents), `models`, credits.
- Transcripts for a probe session: Claude `~/.claude/projects/-Users-<user>-...-workhub2/<sessionId>.jsonl`;
  Kiro `~/.kiro/sessions/cli/<sessionId>.json` + `.jsonl` (flatter than the layout in PLAN.md section 4).
- Session ids and agent names: see logs.

## Problems hit

- Electron 45 has no install script: `require('electron')` fails until `node_modules/electron/install.js` runs;
  added to `postinstall`.
- ACP SDK 2.x API is `client().onRequest/onNotification().connect(ndJsonStream)`, not the old
  `ClientSideConnection` class; it is ESM-only, so electron-vite bundles it into the CJS main (`externalizeDeps.exclude`).
- The project is CJS, so the probe wraps its body in `main()` (tsx rejects top-level await in CJS).
- Both agents take 10-15 s for `session/new` because they start all user MCP servers.
- Cosmetic: switching agent shows the old agent's `[agent process exited]` line.
- Probe runs create real sessions in the user's `~/.claude/projects` and `~/.kiro/sessions`, and the Claude
  user hooks fire; the OAuth URLs in the Kiro log are redacted by the probe.
- `out/` is electron-vite's build dir and gets cleaned, so screenshots live in `screenshots/`.
