import type { Result, WorkhubConfig } from '@workhub/core'

/** Runs one configuration write from a Settings form: shows its issues or "Saved" and refreshes the snapshot. */
export type Run = (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>
