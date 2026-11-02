// Types of the chat's Listen bridge (window.hub.listen), shared by main, preload and renderer.
import type { ListenSummaryResult } from '@workhub/core'

export type { ListenSummaryResult }

export interface ListenApi {
  /**
   * Summarizes an agent message of a session for listening, with a cheap Claude model on the
   * session's Claude account (Settings → General → Voice → Summary model). `requestId` lets
   * `cancel` stop it.
   */
  summarize(requestId: string, sessionId: string, text: string): Promise<ListenSummaryResult>
  /** Stops a summary still running; its `summarize` answers `cancelled`. */
  cancel(requestId: string): void
}
