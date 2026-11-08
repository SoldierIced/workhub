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

export class WebPushProvider implements PushProvider {
  readonly publicKey: string

  constructor(private readonly keys: VapidKeys) {
    this.publicKey = keys.publicKey
  }

  async send(sub: PushSubscriptionRecord, payload: string): Promise<void> {
    try {
      await sendNotification(sub, payload, {
        vapidDetails: { subject: this.keys.subject, publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
        TTL: 60 * 60,
        urgency: 'high'
      })
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      const failure = new Error(`push failed with ${status ?? 'no status'}`) as Error & { gone?: boolean }
      failure.gone = status === 404 || status === 410
      throw failure
    }
  }
}
