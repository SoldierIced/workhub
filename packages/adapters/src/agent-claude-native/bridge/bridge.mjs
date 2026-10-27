// Workhub app-mode bridge: runs one Claude Code session through the Claude Agent SDK and talks
// to the app with one JSON object per line.
//
// Copied from Workhub 1 (Bridge/bridge.mjs) with its message protocol unchanged. Changes for
// Workhub 2: `claude` is found on Windows too, and the MCP status is also sent once the session
// is initialized, so the app shows it before the first turn.
//
// app -> bridge (stdin):
//   {"type":"start","cwd","executable"?,"configDir"?,"sessionId"?,"resume"?,
//    "model"?,"effort"?,"permissionMode"?,"fast"?,"readOnly"?}
//   {"type":"user","text"} or {"type":"user","content":[text and image blocks]}, each with
//    "uuid"? and "priority"? ("next" for a message sent while a turn runs)
//   {"type":"permission","id","result":{behavior,...}}
//   {"type":"interrupt"}
//   {"type":"set_model","model"|null} {"type":"set_effort","effort"|null}
//   {"type":"set_permission_mode","mode"} {"type":"set_fast","enabled"}
//   {"type":"mcp_status"} {"type":"mcp_reconnect","name"} {"type":"mcp_toggle","name","enabled"}
// bridge -> app (stdout):
//   {"type":"ready"} {"type":"sdk","message":<SDKMessage>}
//   {"type":"options","models":[ModelInfo],"commands":[SlashCommand],"fastModeState","defaults":{permissionMode,effort}}
//   {"type":"option_error","name","message"}
//   {"type":"mcp_status","servers":[{name,status,source?,scope?,error?,toolCount,tools:[names]}]}
//     (sent a few seconds after init, after every reconnect/toggle and on request; the SDK has no call
//     that starts an MCP sign-in, so servers that need it are only reported as status "needs-auth")
//   {"type":"mcp_error","name","message"}
//   {"type":"permission_request","id","toolName","input","suggestions"}
//   {"type":"permission_cancelled","id"} {"type":"error","message"} {"type":"closed"}
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { query, resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "./env.mjs";

const send = (object) => process.stdout.write(JSON.stringify(object) + "\n");

const pendingPermissions = new Map();
const queued = [];
let wakeReader = null;
let inputClosed = false;
let session = null;
const abortController = new AbortController();

// The app closed the session (stdin closed or SIGTERM). Claude is ended the way a terminal user
// ends it: the running turn is interrupted and the prompt stream closes, so Claude exits on its
// own and runs its SessionEnd hooks and closes its MCP servers (the session-memory server records the session as
// ended). Only a Claude that does not finish in time is aborted.
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const resolve of pendingPermissions.values()) resolve({ behavior: "deny", message: "Workhub closed." });
  pendingPermissions.clear();
  session?.interrupt().catch(() => {});
  inputClosed = true;
  wakeReader?.();
  setTimeout(() => abortController.abort(), 5000);
  setTimeout(() => process.exit(0), 7000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);

function enqueue(message) {
  queued.push(message);
  wakeReader?.();
  wakeReader = null;
}

// The session's prompt stream stays open for the whole conversation; each typed message is
// one user turn, stamped as human input.
async function* prompts() {
  while (true) {
    while (queued.length === 0) {
      if (inputClosed) return;
      await new Promise((resolve) => (wakeReader = resolve));
    }
    yield queued.shift();
  }
}

function askHost(toolName, input, options) {
  return new Promise((resolve) => {
    const id = randomUUID();
    pendingPermissions.set(id, resolve);
    send({ type: "permission_request", id, toolName, input, suggestions: options.suggestions ?? [] });
    options.signal?.addEventListener("abort", () => {
      if (!pendingPermissions.has(id)) return;
      pendingPermissions.delete(id);
      resolve({ behavior: "deny", message: "The request was cancelled." });
      send({ type: "permission_cancelled", id });
    });
  });
}

// The user's `claude`, as their shell finds it; without one the SDK runs the Claude Code it bundles.
function findClaude() {
  try {
    if (process.platform === "win32") {
      return execFileSync("where", ["claude"], { encoding: "utf8" }).split(/\r?\n/).find((line) => line.trim())?.trim() || undefined;
    }
    return execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function slackPluginEnabled(configDir) {
  try {
    const user = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    return user?.enabledPlugins?.["slack@claude-plugins-official"] === true;
  } catch {
    return false;
  }
}

async function start(config) {
  if (config.configDir) process.env.CLAUDE_CONFIG_DIR = config.configDir;
  // Wait up to 15 s for MCP servers before the first turn: the SDK otherwise starts it with the ones
  // still connecting missing (Slack among them). A value from the user's env wins. Electron's own
  // variables (ELECTRON_RUN_AS_NODE) never reach Claude Code or the commands its tools run.
  const env = agentEnv(process.env, { CLAUDE_CODE_MCP_STARTUP_WAIT_MS: "15000" });
  const options = {
    cwd: config.cwd,
    pathToClaudeCodeExecutable: config.executable ?? findClaude(),
    includePartialMessages: true,
    env,
    canUseTool: askHost,
    abortController,
    // Lets the session honor a `bypassPermissions` default from settings and switch to it later,
    // as the terminal does; it does not turn bypass on by itself.
    allowDangerouslySkipPermissions: true,
    // Stream Claude's (summarized) thinking, as the terminal shows it; the SDK omits it otherwise.
    thinking: { type: "adaptive", display: "summarized" },
    // The predicted next prompt after each turn, offered under the composer as in the terminal.
    promptSuggestions: true,
  };
  if (config.resume) options.resume = config.resume;
  else if (config.sessionId) options.sessionId = config.sessionId;
  // What the composer had chosen, so switching views keeps model, effort and mode.
  if (config.model) options.model = config.model;
  if (config.permissionMode) options.permissionMode = config.permissionMode;
  // An AI reviewer reads only: the tools that change files are not offered at all.
  if (config.readOnly) options.disallowedTools = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
  const settings = {};
  // In SDK sessions the claude.ai Slack connector shadows the official Slack plugin (both serve
  // mcp.slack.com), so an unauthorized connector hides a working plugin. When the account has the
  // plugin enabled, leave the connector out so the plugin's Slack tools load, as in the terminal.
  if (slackPluginEnabled(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"))) {
    settings.deniedMcpServers = [{ serverName: "claude.ai Slack" }];
  }
  if (config.effort) settings.effortLevel = config.effort;
  if (config.fast) settings.fastMode = true;
  if (Object.keys(settings).length > 0) options.settings = settings;

  session = query({ prompt: prompts(), options });
  send({ type: "ready" });
  // The model list, plus the mode and effort the settings start the session with: the CLI only
  // reports them with the first turn.
  Promise.all([session.initializationResult(), resolveSettings({ cwd: config.cwd }).catch(() => null)])
    .then(([init, settings]) => {
      // MCP servers start before the first turn; report them now and again once they had time.
      sendMcpStatus();
      setTimeout(sendMcpStatus, 4000).unref();
      return send({
        type: "options",
        models: init.models,
        commands: init.commands,
        fastModeState: init.fast_mode_state ?? null,
        defaults: {
          // The mode asked for at start wins over the settings' default (a read-only reviewer runs in plan).
          permissionMode: config.permissionMode ?? settings?.effective?.permissions?.defaultMode ?? null,
          effort: settings?.effective?.effortLevel ?? null,
        },
      });
    })
    .catch(() => {});
  try {
    for await (const message of session) {
      send({ type: "sdk", message });
      if (message.type === "system" && message.subtype === "init") {
        initTools = Array.isArray(message.tools) ? message.tools : [];
        // Servers start `pending`; report again once they have had time to connect.
        setTimeout(sendMcpStatus, 4000).unref();
        setTimeout(sendMcpStatus, 15000).unref();
      }
    }
    send({ type: "closed" });
  } catch (error) {
    send({ type: "error", message: String(error?.message ?? error) });
  }
  process.exit(0);
}

// MCP servers as the terminal's /mcp lists them. Tool names come from the server status, or from
// the init message's tool list (`mcp__<server>__<tool>`, the server name with every character
// outside [A-Za-z0-9_-] turned into "_", so `plugin:a:b` is `mcp__plugin_a_b__`).
let initTools = [];
const mcpPrefix = (name) => `mcp__${name.replace(/[^A-Za-z0-9_-]/g, "_")}__`;

async function sendMcpStatus() {
  if (!session || closing) return;
  try {
    const statuses = await session.mcpServerStatus();
    const servers = statuses.map((server) => {
      const prefix = mcpPrefix(server.name);
      const tools = server.tools?.length
        ? server.tools.map((tool) => tool.name)
        : initTools.filter((tool) => tool.startsWith(prefix)).map((tool) => tool.slice(prefix.length));
      return {
        name: server.name,
        status: server.status,
        source: server.source ?? null,
        scope: server.scope ?? null,
        error: server.error ?? null,
        toolCount: tools.length,
        tools,
      };
    });
    send({ type: "mcp_status", servers });
  } catch (error) {
    send({ type: "mcp_error", name: "", message: String(error?.message ?? error) });
  }
}

function mcpChange(name, change) {
  if (!session || typeof name !== "string") return;
  change()
    .catch((error) => send({ type: "mcp_error", name, message: String(error?.message ?? error) }))
    .finally(sendMcpStatus);
}

// Session settings changed from the composer; a refusal goes back to the app as a notice.
function control(name, change) {
  if (!session) return;
  change().catch((error) => send({ type: "option_error", name, message: String(error?.message ?? error) }));
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  switch (message.type) {
    case "start":
      if (!session) start(message);
      break;
    case "user":
      enqueue({
        type: "user",
        message: { role: "user", content: message.content ?? message.text },
        parent_tool_use_id: null,
        origin: { kind: "human" },
        // The app's id for the prompt (results list the ones they answer) and, for a message sent
        // while a turn runs, priority "next": Claude folds it into the turn between tool rounds.
        ...(typeof message.uuid === "string" ? { uuid: message.uuid } : {}),
        ...(message.priority === "next" || message.priority === "later" ? { priority: message.priority } : {}),
      });
      break;
    case "permission": {
      const resolve = pendingPermissions.get(message.id);
      pendingPermissions.delete(message.id);
      resolve?.(message.result);
      break;
    }
    case "interrupt":
      session?.interrupt().catch(() => {});
      break;
    case "set_model":
      control("model", () => session.setModel(message.model ?? undefined));
      break;
    case "set_effort":
      control("effort", () => session.applyFlagSettings({ effortLevel: message.effort ?? null }));
      break;
    case "set_permission_mode":
      control("permission mode", () => session.setPermissionMode(message.mode));
      break;
    case "set_fast":
      control("fast mode", () => session.applyFlagSettings({ fastMode: Boolean(message.enabled) }));
      break;
    case "mcp_status":
      sendMcpStatus();
      break;
    case "mcp_reconnect":
      mcpChange(message.name, () => session.reconnectMcpServer(message.name));
      break;
    case "mcp_toggle":
      mcpChange(message.name, () => session.toggleMcpServer(message.name, Boolean(message.enabled)));
      break;
  }
});
lines.on("close", shutdown);
