/** Why a plan usage read failed; the message is shown as is, the code lets the UI pick its copy. */
export class PlanUsageError extends Error {
  constructor(
    readonly code: 'noLogin' | 'expired' | 'rateLimited' | 'offline' | 'http' | 'unreadable',
    message: string
  ) {
    super(message)
    this.name = 'PlanUsageError'
  }
}
