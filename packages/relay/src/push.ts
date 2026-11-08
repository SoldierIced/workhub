// Web Push through VAPID. The relay only ever pushes a sealed box the desktop made for the device,
// so the push service, and the relay, see ciphertext.
import { generateVAPIDKeys, sendNotification } from 'web-push'
import type { PushProvider, PushSubscriptionRecord } from './core'

export interface VapidKeys {
  publicKey: string
  privateKey: string
  /** `mailto:` or https URL the push services may contact about abuse. */
  subject: string
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return generateVAPIDKeys()
}

/**
 * Where browsers receive push. A subscription endpoint outside these hosts is refused: the relay
 * would otherwise POST, with its VAPID identity, to any address a client names (its own network
 * included). More hosts come from `PUSH_ENDPOINT_HOSTS`, for a push service this list lacks.
 */
export const DEFAULT_PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com']

/** Whether the endpoint's host is one of `hosts` or a subdomain of one (https only). */
export function pushEndpointAllowed(endpoint: string, hosts: readonly string[] = DEFAULT_PUSH_HOSTS): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return hosts.some((h) => host === h || host.endsWith(`.${h}`))
}

export class WebPushProvider implements PushProvider {
  readonly publicKey: string
  private readonly hosts: readonly string[]

  constructor(
    private readonly keys: VapidKeys,
    options: { extraHosts?: readonly string[]; timeoutMs?: number } = {}
  ) {
    this.publicKey = keys.publicKey
    this.hosts = [...DEFAULT_PUSH_HOSTS, ...(options.extraHosts ?? [])].map((h) => h.trim().toLowerCase()).filter(Boolean)
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  private readonly timeoutMs: number

  allows(endpoint: string): boolean {
    return pushEndpointAllowed(endpoint, this.hosts)
  }

  async send(sub: PushSubscriptionRecord, payload: string): Promise<void> {
    if (!this.allows(sub.endpoint)) throw Object.assign(new Error('push endpoint not allowed'), { gone: true })
    try {
      await sendNotification(sub, payload, {
        vapidDetails: { subject: this.keys.subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
        TTL: 60 * 60,
        urgency: 'high',
        timeout: this.timeoutMs
      })
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      const failure = new Error(`push failed with ${status ?? 'no status'}`) as Error & { gone?: boolean }
      failure.gone = status === 404 || status === 410
      throw failure
    }
  }
}
