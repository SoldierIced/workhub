// Session helpers for Workhub; each command prints one JSON value on stdout.
// Copied from Workhub 1 (Bridge/sessions.mjs); `messages` also carries each message's transcript timestamp.
//   node sessions.mjs list <dir>
//   node sessions.mjs all [limit]       every session of the account, any folder
//   node sessions.mjs messages <sessionId> <dir>
//   node sessions.mjs rename <sessionId> <dir> <title>
// CLAUDE_CONFIG_DIR picks the account, as it does for claude itself.
import { getSessionMessages, listSessions, renameSession } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The SDK drops each line's `timestamp`; read it back from the transcript by message uuid (best effort).
function withTimestamps(sessionId, messages) {
  try {
    const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
    const dir = readdirSync(projects).find((d) => existsSync(join(projects, d, `${sessionId}.jsonl`)));
    if (!dir) return messages;
    const at = new Map();
    for (const line of readFileSync(join(projects, dir, `${sessionId}.jsonl`), "utf8").split("\n")) {
      if (!line.includes('"timestamp"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.uuid && typeof entry.timestamp === "string") at.set(entry.uuid, entry.timestamp);
      } catch {}
    }
    return messages.map((m) => (at.has(m.uuid) ? { ...m, timestamp: at.get(m.uuid) } : m));
  } catch {
    return messages;
  }
}

const print = (value) => process.stdout.write(JSON.stringify(value));
const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "list":
      print(await listSessions({ dir: args[0], limit: 60 }));
      break;
    case "all":
      print(await listSessions({ limit: Number(args[0]) || 400 }));
      break;
    case "messages":
      print(withTimestamps(args[0], await getSessionMessages(args[0], { dir: args[1] })));
      break;
    case "rename":
      await renameSession(args[0], args[2], { dir: args[1] });
      print({ ok: true });
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  print({ error: String(error?.message ?? error) });
  process.exitCode = 1;
}
