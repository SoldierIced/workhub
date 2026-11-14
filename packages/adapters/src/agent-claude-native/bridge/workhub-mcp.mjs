// Workhub's MCP server: the local control endpoint (packages/app/src/main/control-server.ts) as MCP
// tools, for any agent that speaks MCP (Claude Code, Codex, Kiro, OpenCode). It adds nothing the
// endpoint does not allow: each tool is one HTTP call to it, with the session and folder added.
//
// It lives with the bridge scripts so packaging ships it as is (<resources>/bridge), and it runs as
// plain Node through the app's own binary (ELECTRON_RUN_AS_NODE=1). No dependencies: MCP over stdio
// is JSON-RPC 2.0, one message per line.
//
// Where the endpoint is: WORKHUB_SOCKET (macOS, Linux) or WORKHUB_URL + WORKHUB_TOKEN (Windows),
// from the session's environment; `--socket <path>` names one when it is installed for agents
// outside Workhub. WORKHUB_SESSION, when set, is sent with every call.
import { request } from "node:http";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const argSocket = (() => {
  const at = process.argv.indexOf("--socket");
  return at > 0 ? process.argv[at + 1] : undefined;
})();
const SOCKET = process.env.WORKHUB_SOCKET || argSocket || "";
const URL_BASE = process.env.WORKHUB_URL || "";
const TOKEN = process.env.WORKHUB_TOKEN || "";
const SESSION = process.env.WORKHUB_SESSION || "";
const CWD = process.env.WORKHUB_CWD || process.cwd();
const TIMEOUT_MS = 30_000;

const INSTRUCTIONS = [
  "Workhub runs this session. These tools read and change the user's Workhub: Plan (meetings, inbox, milestones, people), automations, the history of past sessions, the human review of your changes and flow maps.",
  "Rules: propose inbox items, never file tracker tickets; leave pending items to the user. An automation you add or edit is saved off: tell the user to turn it on in Automations. Ask before changing anything the user did not ask for. Never put secrets in what you send.",
].join(" ");

const str = { type: "string" };
const int = { type: "integer", minimum: 1 };
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const anyObj = { type: "object", additionalProperties: true };
const links = { type: ["array", "null"], items: { anyOf: [str, obj({ label: str, url: str }, ["url"])] }, description: "At most 20 http(s) links; null clears" };

/** The tools: name, description, input schema, and the call they make. */
const TOOLS = [
  {
    name: "plan_today",
    description: "Today's and tomorrow's meetings of the user's profile: title, start/end, attendees, meeting link, short description, prepared brief.",
    inputSchema: obj({}),
    call: () => ["GET", "/v1/plan/today"],
  },
  {
    name: "inbox_list",
    description: "Items of the Plan inbox (tasks, bugs, decisions), open first. Filter instead of reading everything.",
    inputSchema: obj({
      status: { type: "string", enum: ["open", "pending", "local", "done", "discarded", "ticket", "all"] },
      kind: { type: "string", enum: ["task", "bug", "decision"] },
      area: str,
      q: { type: "string", description: "Words in the title or detail" },
      limit: { ...int, maximum: 200 },
    }),
    call: (a) => ["GET", "/v1/inbox", a],
  },
  {
    name: "inbox_propose",
    description: "Proposes items for the inbox (pending until the user approves). Returns the new ids and the ids of open items with the same title. Detail is Markdown.",
    inputSchema: obj(
      {
        source: { type: "string", description: "Where they came from, e.g. the task or meeting" },
        sourceType: { type: "string", enum: ["meeting"] },
        items: {
          type: "array",
          maxItems: 20,
          items: obj(
            {
              kind: { type: "string", enum: ["task", "bug", "decision"] },
              title: { type: "string", maxLength: 300 },
              detail: str,
              people: { type: "array", items: str, description: "Names or emails" },
              due: { type: "string", description: "YYYY-MM-DD" },
              area: str,
              criticality: str,
              link: str,
              links,
            },
            ["title"],
          ),
        },
      },
      ["items"],
    ),
    call: (a) => ["POST", "/v1/inbox", a],
  },
  {
    name: "inbox_update",
    description: "Changes one inbox item: status (local, done, discarded, pending), due, area, criticality, a note appended to the detail, links, or a link to an existing ticket ({key}). Never creates a ticket.",
    inputSchema: obj(
      {
        id: str,
        status: { type: "string", enum: ["local", "done", "discarded", "pending"] },
        due: { type: ["string", "null"] },
        area: str,
        criticality: { type: ["string", "null"] },
        note: { type: "string", maxLength: 2000 },
        links,
        ticket: { anyOf: [obj({ key: str, connectionId: str }, ["key"]), { type: "null" }] },
      },
      ["id"],
    ),
    call: ({ id, ...rest }) => ["PATCH", `/v1/inbox/${encodeURIComponent(id)}`, rest],
  },
  {
    name: "milestones_list",
    description: "Milestones with status, progress vs elapsed time, and their pieces (tickets, tasks, links).",
    inputSchema: obj({}),
    call: () => ["GET", "/v1/milestones"],
  },
  {
    name: "milestone_save",
    description: "Creates a milestone (no id) or changes one (id). Prefer `items` (tickets, inbox tasks, links, each with weight 1-10) over a typed `progress`. Send a short `reason`. A 202 answer means it waits for the user.",
    inputSchema: obj(
      {
        id: str,
        name: str,
        start: { type: "string", description: "YYYY-MM-DD" },
        end: { type: "string", description: "YYYY-MM-DD" },
        items: { type: "array", maxItems: 100, items: anyObj, description: '{kind:"ticket",key} | {kind:"task",itemId} | {kind:"link",url,label,done}; optional weight' },
        query: str,
        progress: { type: "integer", minimum: 0, maximum: 100 },
        notes: str,
        link: str,
        links,
        reason: str,
      },
      ["reason"],
    ),
    call: ({ id, ...rest }) => (id ? ["PATCH", `/v1/milestones/${encodeURIComponent(id)}`, rest] : ["POST", "/v1/milestones", rest]),
  },
  {
    name: "milestone_delete",
    description: "Deletes a milestone. Only when the user asks.",
    inputSchema: obj({ id: str }, ["id"]),
    call: ({ id }) => ["DELETE", `/v1/milestones/${encodeURIComponent(id)}`, {}],
  },
  {
    name: "people_list",
    description: "The people the user meets: names, emails, handles.",
    inputSchema: obj({}),
    call: () => ["GET", "/v1/people"],
  },
  {
    name: "automations_list",
    description: "The user's automations (prompt, agent, folder, triggers, window, limits, state) and their last runs.",
    inputSchema: obj({}),
    call: () => ["GET", "/v1/automations"],
  },
  {
    name: "automation_save",
    description:
      "Adds an automation (no id; `name` required) or changes the fields sent of one (id; triggers, window and limits merge). It is always saved OFF: the user turns it on in Automations.",
    inputSchema: obj(
      {
        id: str,
        automation: obj({
          name: str,
          prompt: { type: "string", description: "Slash command or prompt sent each run" },
          agentKey: { type: "string", description: "agentId or agentId:accountId; copy one from automations_list" },
          folder: str,
          view: { type: "string", enum: ["app", "console"] },
          model: str,
          effort: str,
          permissionMode: str,
          enabled: { type: "boolean", enum: [false], description: "Only false: turns it off" },
          triggers: obj({ intervalMinutes: { type: ["integer", "null"], minimum: 1 }, chatChannelIds: { type: "array", items: str }, prOwner: str }),
          window: obj({ days: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } }, startHour: int, endHour: int }),
          limits: obj({ maxRuns: int, perMinutes: int, maxPerDay: { type: ["integer", "null"], minimum: 1 } }),
          usageThreshold: { type: "integer", minimum: 1, maximum: 100 },
          sessionPolicy: { type: "string", enum: ["reuse", "newEachRun"] },
          clearContext: { type: "boolean" },
          runTimeoutMinutes: int,
          receivesChatReplies: { type: "boolean" },
          notify: { type: "string", enum: ["failures", "always", "never"] },
        }),
      },
      ["automation"],
    ),
    call: ({ id, automation }) => (id ? ["PATCH", `/v1/automations/${encodeURIComponent(id)}`, { automation }] : ["POST", "/v1/automations", { automation }]),
  },
  {
    name: "history_search",
    description: "Past sessions of every agent, newest first: title, first prompt, folder, branch, automation.",
    inputSchema: obj({
      q: { type: "string", description: "Words in title, prompt, folder or branch" },
      agent: str,
      automation: { type: "string", description: "An automation id" },
      folder: { type: "string", description: "Sessions in this folder or below" },
      limit: { ...int, maximum: 200 },
    }),
    call: (a) => ["GET", "/v1/history", a],
  },
  {
    name: "history_read",
    description: "The last messages of one past session (user and agent text shortened, tool titles only).",
    inputSchema: obj({ agentId: str, agentSessionId: str, account: str, limit: { ...int, maximum: 500 } }, ["agentId", "agentSessionId"]),
    call: ({ agentId, agentSessionId, ...rest }) => ["GET", `/v1/history/${encodeURIComponent(agentId)}/${encodeURIComponent(agentSessionId)}`, rest],
  },
  {
    name: "review_open",
    description: "Opens Workhub's human review of this session's changes (the user comments, the comments come back as a message). Needs a Workhub session.",
    inputSchema: obj({ repos: { type: "array", maxItems: 20, items: obj({ path: { type: "string", description: "Absolute repo path" }, base: str }, ["path"]) } }),
    call: (a) => (SESSION ? ["POST", `/v1/sessions/${encodeURIComponent(SESSION)}/review`, { repos: a.repos ?? [] }] : null),
  },
  {
    name: "flow_map_save",
    description: "Validates and stores a flow map (the Flow maps screen). Errors name the fields.",
    inputSchema: obj({ map: anyObj }, ["map"]),
    call: ({ map }) => ["POST", "/v1/flow-maps", map, { raw: true }],
  },
];

/** One call to the endpoint; resolves to { status, body } (body parsed when it is JSON). */
function http(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) };
    let options;
    if (URL_BASE) {
      const u = new URL(path, URL_BASE);
      options = { host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...headers, authorization: `Bearer ${TOKEN}` } };
    } else options = { socketPath: SOCKET, path, method, headers };
    const req = request(options, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let parsed = text;
        try {
          parsed = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("Workhub did not answer in time")));
    req.on("error", reject);
    req.end(payload);
  });
}

/** Runs a tool: the session and folder go in the query of a GET or DELETE and in the body of the rest. */
export async function callTool(name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { isError: true, text: `unknown tool ${name}` };
  if (!SOCKET && !URL_BASE) return { isError: true, text: "Workhub's endpoint is not reachable: this agent does not run in a Workhub session, or Workhub is not open." };
  const spec = tool.call(args ?? {});
  if (!spec) return { isError: true, text: "this tool needs a Workhub session (WORKHUB_SESSION is not set)" };
  const [method, path, data, how] = spec;
  const who = { ...(SESSION ? { session: SESSION } : {}), cwd: CWD };
  let target = path;
  let body;
  if (method === "GET" || method === "DELETE") {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...(data ?? {}), ...who })) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    target = `${path}?${params}`;
  } else body = how?.raw ? data : { ...(data ?? {}), ...who };
  try {
    const r = await http(method, target, body);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { isError: r.status >= 400, text };
  } catch (e) {
    return { isError: true, text: `Workhub could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export const toolList = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

const write = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize":
      return write({
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "workhub", version: "1.0.0" },
          instructions: INSTRUCTIONS,
        },
      });
    case "ping":
      return write({ id, result: {} });
    case "tools/list":
      return write({ id, result: { tools: toolList() } });
    case "tools/call": {
      const r = await callTool(params?.name, params?.arguments);
      return write({ id, result: { content: [{ type: "text", text: r.text }], isError: r.isError } });
    }
    default:
      if (isRequest) write({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write({ id: null, error: { code: -32700, message: "parse error" } });
    }
    handle(msg).catch((e) => msg.id !== undefined && write({ id: msg.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }));
  });
  lines.on("close", () => process.exit(0));
}
