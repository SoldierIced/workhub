// Where the user's Claude Code is, for the SDK's `pathToClaudeCodeExecutable`. Without one the SDK
// runs the Claude Code it bundles.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";

// Windows paths on purpose: the pick is unit-tested from other platforms.
const { dirname, join } = win32;

/**
 * Picks, among the paths Windows' `where claude` prints, one the SDK can launch. The SDK spawns a
 * path directly unless it ends in .js/.mjs (then it runs it with node), so an npm shim such as
 * `C:\nvm4w\nodejs\claude` (a shell script, listed first by `where`) or `claude.cmd` fails with
 * "native binary ... failed to launch". Order: a native `claude.exe` on PATH, the native installer's
 * `~/.local/bin/claude.exe`, then what the npm shim stands for: the package's `bin/claude.exe`
 * (recent npm builds ship the native binary) or its `cli.js` (older ones; the SDK runs it with node).
 */
export function pickWindowsClaude(lines, exists = existsSync, home = homedir()) {
  const paths = lines.map((line) => line.trim()).filter(Boolean);
  const exe = paths.find((p) => /\.exe$/i.test(p));
  if (exe) return exe;
  const native = join(home, ".local", "bin", "claude.exe");
  if (exists(native)) return native;
  for (const p of paths) {
    const pkg = join(dirname(p), "node_modules", "@anthropic-ai", "claude-code");
    for (const entry of [join(pkg, "bin", "claude.exe"), join(pkg, "cli.js")]) if (exists(entry)) return entry;
  }
  return undefined;
}

/** The user's `claude`, as their shell finds it; undefined when there is none the SDK can run. */
export function findClaude() {
  try {
    if (process.platform === "win32") {
      return pickWindowsClaude(execFileSync("where", ["claude"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/));
    }
    return execFileSync("/bin/sh", ["-c", "command -v claude"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}
