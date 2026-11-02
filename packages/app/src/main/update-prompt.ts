/**
 * The "a new version is available" prompt: shown after an automatic check finds a newer version, at
 * most once a day, and never again for a version the user chose to skip. "Check now" in Settings
 * never prompts (the screen shows the result itself).
 */
export interface UpdatePromptState {
  /** When the prompt was last shown (epoch ms). */
  lastPromptAt?: number
  /** A version the user chose to skip; a newer one prompts again. */
  skippedVersion?: string
}

export const UPDATE_PROMPT_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Whether an automatic check that found `version` shows the prompt now. */
export function shouldPromptUpdate(state: UpdatePromptState, version: string | undefined, now: number): boolean {
  if (!version || version === state.skippedVersion) return false
  return state.lastPromptAt === undefined || now - state.lastPromptAt >= UPDATE_PROMPT_INTERVAL_MS || now < state.lastPromptAt
}

/** Reads the stored prompt state defensively. */
export function readUpdatePromptState(raw: unknown): UpdatePromptState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    ...(typeof r['lastPromptAt'] === 'number' && Number.isFinite(r['lastPromptAt']) ? { lastPromptAt: r['lastPromptAt'] } : {}),
    ...(typeof r['skippedVersion'] === 'string' && r['skippedVersion'] ? { skippedVersion: r['skippedVersion'] } : {})
  }
}
