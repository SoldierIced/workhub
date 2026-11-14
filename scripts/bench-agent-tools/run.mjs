#!/usr/bin/env node
/**
 * Benchmark: how an agent reaches Workhub, through the `workhub-*` skills (curl to the endpoint)
 * or through Workhub's MCP server, measured on the same tasks with Claude Code in print mode.
 * Every run gets its own synthetic endpoint (server.mts) in a temp folder and never reaches a real
 * Workhub: WORKHUB_SOCKET is replaced and hooks are off.
 *
 *   node scripts/bench-agent-tools/run.mjs [--model sonnet] [--reps 2] [--modes skills,mcp,mcpDeferred,none] [--tasks hi,today,automation,history]
 *
 * It spends real usage of the signed-in Claude account. Results: a JSON file in the temp folder
 * and a table on stdout.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const MCP_SCRIPT = join(root, "packages/adapters/src/agent-claude-native/bridge/workhub-mcp.mjs");
const SESSION = "bench-session";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const MODEL = arg("model", "sonnet");
const REPS = Number(arg("reps", "2"));
const MODES = arg("modes", "none,skills,mcp,mcpDeferred").split(",");
const TASKS = arg("tasks", "hi,today,automation,history").split(",");
const PARALLEL = Number(arg("parallel", "3"));

const TASK = {
  hi: { prompt: "Reply with just the word: ok", check: (log) => log.filter((l) => l.url).length === 0 },
  today: {
    prompt: "What meetings do I have today in Workhub? One line each.",
    check: (log, text) => log.some((l) => l.url?.startsWith("/v1/plan/today")) && /checkout weekly sync/i.test(text),
  },
  automation: {
    prompt: "In Workhub, add an automation called 'Nightly triage' that runs the /triage command every 30 minutes, weekdays 9 to 18, in the folder ~/work/acme-api.",
    check: (log) =>
      log.some((l) => l.created && /nightly triage/i.test(l.created.name ?? "") && l.created.prompt?.trim() === "/triage" && l.created.triggers?.intervalMinutes === 30),
  },
  history: {
    prompt: "In my Workhub session history, find my past session about rolling back the checkout deploy and tell me in two lines what was done.",
    check: (log, text) => log.some((l) => l.url?.startsWith("/v1/history/claude/h-101")) && /4f2a1c9|2\.14\.3/.test(text),
  },
};

function run(cmd, args, opts) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => done({ code, out, err }));
  });
}

async function startServer(dir) {
  const socket = join(dir, "c.sock");
  const log = join(dir, "log.jsonl");
  writeFileSync(log, "");
  const child = spawn(join(root, "node_modules/.bin/tsx"), [join(here, "server.mts"), socket, log], { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((ok, fail) => {
    child.stdout.on("data", (c) => String(c).includes("listening") && ok());
    child.on("exit", () => fail(new Error("server exited")));
  });
  return { socket, log, stop: () => child.kill() };
}

function projectFor(mode, dir) {
  const proj = join(dir, "project");
  mkdirSync(proj, { recursive: true });
  if (mode === "skills") {
    for (const name of readdirSync(join(root, "skills")).filter((n) => n.startsWith("workhub-"))) {
      cpSync(join(root, "skills", name), join(proj, ".claude", "skills", name), { recursive: true });
    }
  }
  return proj;
}

async function once(mode, task, rep) {
  const dir = mkdtempSync(join(tmpdir(), `whb-${mode}-${task}-`));
  const server = await startServer(dir);
  const proj = projectFor(mode, dir);
  const env = { ...process.env, WORKHUB_SOCKET: server.socket, WORKHUB_SESSION: SESSION, WORKHUB_URL: "", WORKHUB_TOKEN: "" };
  const args = ["-p", TASK[task].prompt, "--output-format", "json", "--model", MODEL, "--max-turns", "15", "--settings", JSON.stringify({ disableAllHooks: true }), "--strict-mcp-config"];
  if (mode === "skills") args.push("--allowedTools", "Bash", "Skill", "Read");
  if (mode === "mcp" || mode === "mcpDeferred") {
    const mcp = { mcpServers: { workhub: { type: "stdio", command: process.execPath, args: [MCP_SCRIPT], env: { WORKHUB_SOCKET: server.socket, WORKHUB_SESSION: SESSION } } } };
    args.push("--mcp-config", JSON.stringify(mcp), "--allowedTools", "mcp__workhub");
    if (mode === "mcpDeferred") env.ENABLE_TOOL_SEARCH = "true";
  }
  const started = Date.now();
  const r = await run("claude", args, { cwd: proj, env });
  server.stop();
  const log = readFileSync(server.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  let res = {};
  try {
    res = JSON.parse(r.out);
  } catch {
    res = { is_error: true, result: r.err.slice(-300) || r.out.slice(-300) };
  }
  const u = res.usage ?? {};
  const row = {
    mode,
    task,
    rep,
    ok: !res.is_error && TASK[task].check(log, String(res.result ?? "")),
    turns: res.num_turns,
    input: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    costUsd: res.total_cost_usd ?? 0,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    calls: log.filter((l) => l.url).map((l) => `${l.method} ${l.url.split("?")[0]}`),
    answer: String(res.result ?? "").slice(0, 160),
  };
  process.stderr.write(`${mode}/${task}#${rep}: ${row.ok ? "ok" : "FAIL"} $${row.costUsd.toFixed(4)} turns=${row.turns}\n`);
  return row;
}

const jobs = [];
for (const task of TASKS) for (const mode of MODES) for (let rep = 1; rep <= (task === "hi" ? 1 : REPS); rep++) jobs.push([mode, task, rep]);
const rows = [];
let next = 0;
await Promise.all(
  Array.from({ length: PARALLEL }, async () => {
    while (next < jobs.length) {
      const [mode, task, rep] = jobs[next++];
      rows.push(await once(mode, task, rep));
    }
  }),
);
const out = join(tmpdir(), `workhub-agent-tools-bench-${Date.now()}.json`);
writeFileSync(out, JSON.stringify({ model: MODEL, rows }, null, 2));

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`model ${MODEL}, results in ${out}\n`);
console.log("task        mode         ok    turns  input+cacheW  cacheRead  output  cost $   secs");
for (const task of TASKS)
  for (const mode of MODES) {
    const rs = rows.filter((r) => r.task === task && r.mode === mode);
    if (!rs.length) continue;
    const f = (k) => Math.round(avg(rs.map((r) => r[k])));
    console.log(
      `${task.padEnd(11)} ${mode.padEnd(12)} ${`${rs.filter((r) => r.ok).length}/${rs.length}`.padEnd(5)} ${String(avg(rs.map((r) => r.turns ?? 0)).toFixed(1)).padStart(5)}  ${String(f("input") + f("cacheWrite")).padStart(12)}  ${String(f("cacheRead")).padStart(9)}  ${String(f("output")).padStart(6)}  ${avg(rs.map((r) => r.costUsd)).toFixed(4)}  ${avg(rs.map((r) => r.seconds)).toFixed(1)}`,
    );
  }
if (!existsSync(out)) process.exit(1);
