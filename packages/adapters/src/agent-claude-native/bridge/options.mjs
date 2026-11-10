// Workhub: what the user's Claude Code offers (models, the efforts each takes, slash commands),
// read without running a turn. It opens a session with no prompt, takes the list Claude Code reports
// when it starts (the same one a session's pickers get), and ends it: no message is sent, nothing is
// billed. The account comes from CLAUDE_CONFIG_DIR, as for every bridge script.
//
// stdout (one JSON line): {"ok":true,"models":[ModelInfo],"commands":[SlashCommand]} or {"ok":false,"error"}
import { homedir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "./env.mjs";
import { findClaude } from "./find-claude.mjs";

const TIMEOUT_MS = Number(process.env.WORKHUB_OPTIONS_TIMEOUT_MS) || 45_000;
const abortController = new AbortController();
let session = null;
const done = (result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  // Ends Claude Code too: closing the session and aborting stop the process the SDK started.
  try {
    session?.close();
  } catch {}
  abortController.abort();
  process.exit(result.ok ? 0 : 1);
};

// A prompt stream that never yields: the session starts and waits, so nothing reaches the model.
async function* nothing() {
  await new Promise(() => {});
}

setTimeout(() => done({ ok: false, error: "Claude Code did not report its options in time" }), TIMEOUT_MS).unref();
try {
  session = query({
    prompt: nothing(),
    // Only the MCP servers passed here (none): the listing does not need the user's servers started.
    options: { cwd: homedir(), pathToClaudeCodeExecutable: findClaude(), env: agentEnv(process.env), abortController, mcpServers: {}, strictMcpConfig: true },
  });
  const init = await session.initializationResult();
  done({ ok: true, models: init.models ?? [], commands: init.commands ?? [] });
} catch (err) {
  done({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
