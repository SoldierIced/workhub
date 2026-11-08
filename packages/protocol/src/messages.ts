// What travels on the wire. The relay sees only the envelope (who talks to whom, when, how much);
// the body is opaque to it: a handshake hello, a sealed box, or a channel message it cannot open.
import { z } from 'zod'
import { isPublicIdentity, type PublicIdentity } from './identity'
import { remoteCapabilitySchema } from './pairing'

export const PROTOCOL_VERSION = 1

const publicIdentitySchema = z.custom<PublicIdentity>(isPublicIdentity, 'a public identity')
const fingerprint = z.string().regex(/^[0-9a-f]{32}$/)
const base64url = z.string().regex(/^[A-Za-z0-9_-]*$/)

/** The largest body the relay forwards (a sealed message; files travel in chunks below this). */
export const MAX_BODY_BYTES = 512 * 1024

// ---- Body: what a client puts in `to` and gets in `from`; the relay never opens it.

export const bodySchema = z.discriminatedUnion('k', [
  /** A handshake hello (plain: ephemeral public keys are public). */
  z.object({ k: z.literal('hs'), e: base64url.length(43) }),
  /** A sealed box to the recipient's static key: pairing, and anything sent without a live channel. */
  z.object({ k: z.literal('box'), e: base64url.length(43), c: base64url.min(1) }),
  /** A channel message, sealed by SecureChannel. */
  z.object({ k: z.literal('enc'), c: base64url.min(1) })
])
export type Body = z.infer<typeof bodySchema>

// ---- Client → relay

export const clientMessageSchema = z.discriminatedUnion('t', [
  /** First message: who I am. `sig` signs "workhub-relay/auth" ‖ ts ‖ id with the Ed25519 key. */
  z.object({ t: z.literal('auth'), v: z.literal(PROTOCOL_VERSION), id: fingerprint, pub: publicIdentitySchema, ts: z.number().int(), sig: base64url }),
  /** Listen in a room: a desktop's own id, or the id of a desktop a device is paired with. */
  z.object({ t: z.literal('join'), room: fingerprint }),
  z.object({ t: z.literal('leave'), room: fingerprint }),
  /** Deliver a body to one peer in the room. */
  z.object({ t: z.literal('to'), room: fingerprint, to: fingerprint, body: bodySchema, ref: z.string().max(64).optional() }),
  /** A device registers where its browser receives Web Push. */
  z.object({
    t: z.literal('push.subscribe'),
    sub: z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }) })
  }),
  z.object({ t: z.literal('push.unsubscribe') }),
  /** A desktop asks the relay to push a sealed box to a device, whether or not it is connected. */
  z.object({ t: z.literal('push'), room: fingerprint, to: fingerprint, box: z.object({ e: base64url.length(43), c: base64url.min(1) }) }),
  z.object({ t: z.literal('ping') })
])
export type ClientMessage = z.infer<typeof clientMessageSchema>

// ---- Relay → client

export const relayErrorCodes = ['unauthenticated', 'bad-auth', 'bad-message', 'not-joined', 'offline', 'too-large', 'rate-limited', 'push-failed', 'no-push'] as const
export type RelayErrorCode = (typeof relayErrorCodes)[number]

export const relayMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), id: fingerprint, now: z.number().int(), push: z.object({ vapidPublicKey: z.string() }).optional() }),
  z.object({ t: z.literal('joined'), room: fingerprint, peers: z.array(fingerprint) }),
  /** A peer came or went in a room this client joined. */
  z.object({ t: z.literal('peer'), room: fingerprint, id: fingerprint, online: z.boolean() }),
  z.object({ t: z.literal('from'), room: fingerprint, from: fingerprint, body: bodySchema }),
  /** A `to` or `push` the relay could not deliver; `ref` echoes the client's. */
  z.object({ t: z.literal('error'), code: z.enum(relayErrorCodes), message: z.string(), ref: z.string().optional() }),
  z.object({ t: z.literal('pong'), now: z.number().int() })
])
export type RelayMessage = z.infer<typeof relayMessageSchema>

// ---- Inside the channel (after SecureChannel.open)

const argsSchema = z.array(z.unknown())

export const channelMessageSchema = z.discriminatedUnion('t', [
  /** First message each way once the channel is up: proves the keys and says what the end is. */
  z.object({ t: z.literal('ready'), capabilities: z.array(remoteCapabilitySchema).optional(), client: z.string().max(80).optional(), desktop: z.string().max(80).optional() }),
  /** hub.<ns>.<method>(...args) as `ipcRenderer.invoke(channel, ...args)`. */
  z.object({ t: z.literal('invoke'), id: z.number().int().nonnegative(), channel: z.string().max(64), args: argsSchema }),
  z.object({
    t: z.literal('result'),
    id: z.number().int().nonnegative(),
    ok: z.boolean(),
    value: z.unknown().optional(),
    error: z.string().max(2000).optional()
  }),
  /** `ipcRenderer.send(channel, ...args)`. */
  z.object({ t: z.literal('send'), channel: z.string().max(64), args: argsSchema }),
  /** An event main sent its windows. */
  z.object({ t: z.literal('event'), channel: z.string().max(64), args: argsSchema }),
  /** The desktop revoked this device or is going away; the device should not reconnect until paired again. */
  z.object({ t: z.literal('bye'), reason: z.enum(['revoked', 'shutdown']) })
])
export type ChannelMessage = z.infer<typeof channelMessageSchema>

// ---- Push payload (the plaintext of the sealed box a push carries)

export const pushPayloadSchema = z.object({
  v: z.literal(1),
  /** What kind of notification, as the desktop names them (permission, finished, pr, alert...). */
  kind: z.string().max(40),
  title: z.string().max(200),
  body: z.string().max(1000),
  ts: z.number().int(),
  /** Where the client opens on tap, as a hash route of the web client. */
  route: z.string().max(200).optional(),
  /** Groups notifications that replace one another (one per session, say). */
  tag: z.string().max(80).optional(),
  /** The desktop that sent it: a phone paired with several switches to it on tap. */
  desktop: fingerprint.optional()
})
export type PushPayload = z.infer<typeof pushPayloadSchema>

export function parseClientMessage(value: unknown): ClientMessage | null {
  const r = clientMessageSchema.safeParse(value)
  return r.success ? r.data : null
}

export function parseRelayMessage(value: unknown): RelayMessage | null {
  const r = relayMessageSchema.safeParse(value)
  return r.success ? r.data : null
}

export function parseChannelMessage(value: unknown): ChannelMessage | null {
  const r = channelMessageSchema.safeParse(value)
  return r.success ? r.data : null
}

export function parsePushPayload(value: unknown): PushPayload | null {
  const r = pushPayloadSchema.safeParse(value)
  return r.success ? r.data : null
}
