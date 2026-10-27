// The environment the bridge hands to Claude Code, and so to every tool command it runs.

/**
 * Variables that only make sense to Workhub's own Electron process. ELECTRON_RUN_AS_NODE above all:
 * the bridge needs it to run as Node, but left in place every `electron`-based tool a session
 * starts (VS Code's CLI, another Electron app) would silently run as plain Node too.
 */
export const ELECTRON_INTERNAL_ENV = ["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ASAR", "ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_RENDERER_URL"];

/** `defaults`, overridden by `base` (the bridge's own env), minus Electron's internal variables. */
export function agentEnv(base, defaults = {}) {
  const env = { ...defaults, ...base };
  for (const name of ELECTRON_INTERNAL_ENV) delete env[name];
  return env;
}
