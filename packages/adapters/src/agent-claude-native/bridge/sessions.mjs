// Session helpers for Workhub; each command prints one JSON value on stdout.
// Copied from Workhub 1 (Bridge/sessions.mjs) unchanged.
//   node sessions.mjs list <dir>
//   node sessions.mjs all [limit]       every session of the account, any folder
//   node sessions.mjs messages <sessionId> <dir>
//   node sessions.mjs rename <sessionId> <dir> <title>
// CLAUDE_CONFIG_DIR picks the account, as it does for claude itself.
import { getSessionMessages, listSessions, renameSession } from "@anthropic-ai/claude-agent-sdk";

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
      print(await getSessionMessages(args[0], { dir: args[1] }));
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
