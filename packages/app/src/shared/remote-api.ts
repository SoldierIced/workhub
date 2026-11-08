// Remote access (a phone or browser paired with this desktop): what a device may do, by capability,
// and what Settings → Remote access shows and does.

/** A group of `hub` calls and events a paired device can be granted. */
export type RemoteCapability = 'sessions' | 'pullRequests' | 'automations' | 'health' | 'plan'

export const REMOTE_CAPABILITIES: readonly RemoteCapability[] = ['sessions', 'pullRequests', 'automations', 'health', 'plan']

export function isRemoteCapability(value: unknown): value is RemoteCapability {
  return typeof value === 'string' && (REMOTE_CAPABILITIES as readonly string[]).includes(value)
}

export type RemoteDevicePlatform = 'ios' | 'android' | 'web' | 'other'

export interface RemoteDeviceView {
  id: string
  /** The fingerprint as people compare it (groups of four). */
  fingerprint: string
  name: string
  platform: RemoteDevicePlatform
  capabilities: RemoteCapability[]
  pairedAt: number
  lastSeenAt?: number
  online: boolean
}

export type RemoteConnectionState = 'off' | 'connecting' | 'online' | 'error'

export interface RemoteStatusView {
  enabled: boolean
  /** The relay as the person typed it (https://relay.example.com). */
  relayUrl: string
  desktopName: string
  /** This desktop's identity, once made. */
  desktopId: string | null
  fingerprint: string | null
  connection: RemoteConnectionState
  error?: string
  /** Whether the relay can push notifications to devices that are offline. */
  pushAvailable: boolean
  devices: RemoteDeviceView[]
  /** A QR being shown (its link and when it expires). */
  pairing: { link: string; expiresAt: number } | null
  /** A device that answered the QR and waits for the person to confirm it. */
  request: { deviceId: string; fingerprint: string; name: string; platform: RemoteDevicePlatform } | null
}

export interface RemoteApi {
  status(): Promise<RemoteStatusView>
  setEnabled(enabled: boolean): Promise<RemoteStatusView>
  setRelayUrl(url: string): Promise<RemoteStatusView>
  setDesktopName(name: string): Promise<RemoteStatusView>
  startPairing(): Promise<RemoteStatusView>
  cancelPairing(): Promise<RemoteStatusView>
  acceptPairing(deviceId: string, capabilities: RemoteCapability[]): Promise<RemoteStatusView>
  rejectPairing(deviceId: string): Promise<RemoteStatusView>
  setCapabilities(deviceId: string, capabilities: RemoteCapability[]): Promise<RemoteStatusView>
  revoke(deviceId: string): Promise<RemoteStatusView>
  onChanged(cb: (status: RemoteStatusView) => void): () => void
}

/** A file inside a session's folder, as a device reads it (an image the agent made, a log). */
export interface RemoteFile {
  name: string
  size: number
  mime: string
  /** base64 of the content. */
  data: string
}
