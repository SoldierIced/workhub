// Workhub headless one-shot query: runs ONE prompt through the Claude Agent SDK with a read-only
// Copied from Workhub 1 (Bridge/oneshot.mjs) unchanged.
// allowlist of tools and prints one JSON object on stdout. Used by the Slack watcher, which reads
// Slack through the Slack connector of the chosen Claude account (no Slack token anywhere).
//
// Read-only is structural: READ_ONLY_SLACK_TOOLS below is the single source of truth (the Swift side
// passes no tool names). Anything not on it is denied, and every denial is reported in `deniedTools`.
//
// stdin (one JSON line):
//   {"prompt","cwd","configDir"?,"model"?,"maxTurns"?,"systemPrompt"?,"timeoutSeconds"?}
// stdout (one JSON line, last line):
//   {"ok","result","isError","subtype","errorMessage"?,"rateLimited","resetsAt"?,"costUsd"?,"durationMs","slackTools":[string],"deniedTools":[string]}
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

const startedAt = Date.now();
const DEFAULT_TIMEOUT_SECONDS = 300;

// ---- BEGIN read-only policy (self-contained: the offline check extracts this block) ----
// The ONLY tools this run may call. Everything else is denied whatever its name looks like, so a
// write tool with an unexpected name cannot slip through. A tool's full name is
// `mcp__<server>__<tool>`; only `<tool>` is compared, because the server part depends on where Slack
// comes from (`plugin_slack_slack` for the Slack plugin, `claude_ai_Slack` for the claude.ai connector).
const READ_ONLY_SLACK_TOOLS = Object.freeze([
  "slack_read_channel", "slack_read_thread", "slack_search_public", "slack_search_public_and_private",
  "slack_search_channels", "slack_search_users", "slack_read_user_profile", "slack_list_user_channels",
  "slack_list_channel_members", "slack_read_canvas", "slack_read_list", "slack_read_file",
  "slack_get_reactions", "slack_search_emojis",
]);
// Server prefixes known so far. They only build the pre-approved names (`allowedTools`); the permission
// callback and the hook decide with isReadOnlySlackTool, which does not depend on this list.
const SLACK_SERVER_PREFIXES = Object.freeze(["mcp__plugin_slack_slack__", "mcp__claude_ai_Slack__", "mcp__slack__"]);
const ALLOWED_TOOLS = SLACK_SERVER_PREFIXES.flatMap((prefix) => READ_ONLY_SLACK_TOOLS.map((tool) => prefix + tool));
const READ_ONLY_SET = new Set(READ_ONLY_SLACK_TOOLS);

// True only for an MCP tool of a Slack server whose tool name is on the allowlist.
function isReadOnlySlackTool(fullName) {
  if (typeof fullName !== "string" || !fullName.startsWith("mcp__")) return false;
  const split = fullName.lastIndexOf("__");
  if (split <= "mcp__".length) return false;
  const server = fullName.slice("mcp__".length, split);
  return /slack/i.test(server) && !server.includes("__") && READ_ONLY_SET.has(fullName.slice(split + 2));
}
// ---- END read-only policy ----

// Known write tools of the official Slack plugin. They are also removed from the model's context
// (`disallowedTools`), which keeps their definitions out of the prompt. That is an optimisation and a
// second wall only: safety comes from the allowlist above, not from this list being complete.
const SLACK_PLUGIN_WRITE_TOOLS = [
  "add_list_record", "add_reaction", "complete_file_upload", "create_canvas", "create_conversation",
  "create_list", "get_file_upload_url", "schedule_message", "send_message", "send_message_draft",
  "update_canvas", "update_list", "update_list_record",
];
const RATE_LIMIT = /rate.?limit|usage.?limit|limit reached|too many requests|\b429\b|overloaded|\b529\b/i;

const outcome = {
  ok: false,
  result: "",
  isError: false,
  subtype: "",
  rateLimited: false,
  durationMs: 0,
  slackTools: [],
  deniedTools: [],
};
let finished = false;

function finish(code = 0) {
  if (finished) return;
  finished = true;
  outcome.durationMs = Date.now() - startedAt;
  process.stdout.write(JSON.stringify(outcome) + "\n", () => process.exit(code));
}

function fail(message, subtype = "error") {
  outcome.ok = false;
  outcome.isError = true;
  outcome.subtype = outcome.subtype || subtype;
  outcome.errorMessage = String(message);
  if (RATE_LIMIT.test(outcome.errorMessage)) outcome.rateLimited = true;
}

// Records a refused tool for the run log (stdout `deniedTools`) and stderr; returns the reason for the model.
function noteDenied(toolName) {
  const name = String(toolName).replace(/[^\x20-\x7e]/g, "?").slice(0, 200);
  if (!outcome.deniedTools.includes(name)) {
    outcome.deniedTools.push(name);
    process.stderr.write(`denied tool: ${name}\n`);
  }
  return `${name} is not on the read-only Slack allowlist; this run only reads.`;
}

const MINIMAL_SYSTEM_PROMPT =
  "You read Slack with the available read-only Slack tools and answer with strict JSON only.";

// Newest installed version of the official Slack plugin in this account, if any.
function findSlackPlugin(configDir) {
  const root = join(configDir, "plugins", "cache", "claude-plugins-official", "slack");
  try {
    const versions = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, ".mcp.json")))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return versions.length ? join(root, versions[versions.length - 1]) : undefined;
  } catch {
    return undefined;
  }
}

// The user's `claude`, as their shell finds it (this runs inside their login shell).
function findClaude() {
  try {
    return execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readRequest() {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim()) {
      lines.close();
      return JSON.parse(line);
    }
  }
  throw new Error("No request on stdin");
}

async function run(request) {
  if (request.configDir) process.env.CLAUDE_CONFIG_DIR = request.configDir;
  const abortController = new AbortController();
  const timeoutMs = (Number(request.timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS) * 1000;
  const timer = setTimeout(() => {
    fail(`Timed out after ${Math.round(timeoutMs / 1000)} s`, "timeout");
    abortController.abort();
    finish(0);
  }, timeoutMs);
  timer.unref();

  const options = {
    cwd: request.cwd || process.cwd(),
    pathToClaudeCodeExecutable: findClaude(),
    // The SDK starts the turn without waiting for MCP servers, so a Slack server still connecting
    // leaves the run with no Slack tools. Wait up to 15 s for them (a value from the user's env wins).
    env: { CLAUDE_CODE_MCP_STARTUP_WAIT_MS: "15000", ...process.env },
    abortController,
    // No built-in tools at all (no Bash, Read, Edit, Write); only MCP tools can run.
    tools: [],
    // Read-only by construction, in three layers that all decide with isReadOnlySlackTool:
    // 1. allowedTools pre-approves exactly the allowlisted Slack tools (nothing else is auto-allowed).
    allowedTools: ALLOWED_TOOLS,
    // Never inherit a more permissive mode (bypass, accept-edits) from the user's settings.
    permissionMode: "default",
    // 2. canUseTool denies every other tool that reaches a permission prompt.
    canUseTool: async (toolName, input) =>
      isReadOnlySlackTool(toolName)
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: noteDenied(toolName) },
    // 3. A PreToolUse hook denies before any allow rule is consulted. canUseTool only sees calls that
    //    would otherwise prompt, so without this a user-level `permissions.allow` rule for a whole Slack
    //    server (loaded in the settingSources: ["user"] fallback) could let a write tool through.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) =>
              isReadOnlySlackTool(input?.tool_name)
                ? {}
                : {
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: noteDenied(input?.tool_name),
                    },
                  },
          ],
        },
      ],
    },
    persistSession: false,
    maxTurns: Number(request.maxTurns) || 8,
    systemPrompt: request.systemPrompt || MINIMAL_SYSTEM_PROMPT,
  };
  if (request.model) options.model = request.model;

  // Cost: loading the user's settings brings every MCP server, plugin, skill and CLAUDE.md
  // (~120k tokens of context per run, measured). When the account has the official Slack plugin,
  // load only that plugin: it reuses the account's Slack login and costs ~4k tokens per run.
  const slackPlugin = findSlackPlugin(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
  if (slackPlugin) {
    options.settingSources = [];
    options.plugins = [{ type: "local", path: slackPlugin }];
    // Write tools are also refused by the permission layers; leaving them out keeps their definitions out of the context.
    options.disallowedTools = SLACK_PLUGIN_WRITE_TOOLS.map((name) => `mcp__plugin_slack_slack__slack_${name}`);
    options.env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  } else {
    // No plugin: fall back to the user's settings so claude.ai connectors (e.g. Slack) still load.
    options.settingSources = ["user"];
  }

  try {
    for await (const message of query({ prompt: request.prompt, options })) {
      if (message.type === "system" && message.subtype === "init") {
        // Every Slack tool the account exposes (read or write): only used to tell whether Slack is connected.
        outcome.slackTools = (message.tools ?? []).filter((name) => /slack/i.test(name));
      } else if (message.type === "rate_limit_event") {
        const info = message.rate_limit_info;
        if (info?.status === "rejected") {
          outcome.rateLimited = true;
          if (info.resetsAt) outcome.resetsAt = new Date(info.resetsAt * 1000).toISOString();
        }
      } else if (message.type === "result") {
        outcome.subtype = message.subtype;
        outcome.isError = Boolean(message.is_error) || message.subtype !== "success";
        outcome.result = typeof message.result === "string" ? message.result : "";
        outcome.costUsd = message.total_cost_usd;
        for (const denial of message.permission_denials ?? []) noteDenied(denial?.tool_name);
        if (outcome.isError) {
          const detail = outcome.result || (message.errors ?? []).join("; ") || message.subtype;
          fail(detail, message.subtype);
        }
      }
    }
    outcome.ok = !outcome.isError && outcome.subtype === "success";
    if (!outcome.ok && !outcome.errorMessage) fail("The query ended without a result", "no_result");
  } catch (error) {
    if (!finished) fail(error?.message ?? error);
  } finally {
    clearTimeout(timer);
  }
  // A rate-limit text in the answer of a failed run also counts, with the reset time if it names one.
  if (outcome.isError && !outcome.resetsAt) {
    const match = /resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i.exec(outcome.errorMessage ?? "");
    if (match && outcome.rateLimited) outcome.resetText = match[1];
  }
  finish(0);
}

try {
  await run(await readRequest());
} catch (error) {
  fail(error?.message ?? error, "bad_request");
  finish(0);
}
