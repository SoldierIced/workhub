// Remote access (a phone or browser paired with this desktop): what a device may do, by capability.

/** A group of `hub` calls and events a paired device can be granted. */
export type RemoteCapability = 'sessions' | 'pullRequests' | 'automations' | 'health'

export const REMOTE_CAPABILITIES: readonly RemoteCapability[] = ['sessions', 'pullRequests', 'automations', 'health']

export function isRemoteCapability(value: unknown): value is RemoteCapability {
  return typeof value === 'string' && (REMOTE_CAPABILITIES as readonly string[]).includes(value)
}
