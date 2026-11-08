# Remote access

Workhub Remote lets a phone (or any browser) see and drive the Workhub on your desktop: the
sessions that are running, their chat, permission prompts, pull requests, automations and
alerts. The desktop keeps running everything; the phone is a second screen with a keyboard.

Nothing of yours passes through a server in the clear. The desktop and the phone pair once, keep
each other's keys, and encrypt every message end to end. The relay they meet through sees who talks
to whom and how much, never what.

## How it fits together

```
phone (web app, later a native app)  ⇄  relay (your server, or one you trust)  ⇄  Workhub on the desktop
          └────────────── end-to-end encrypted: the relay forwards ciphertext ──────────────┘
```

- **Identity.** Each end has a key pair made once and kept locally (the desktop in its secret store,
  the phone in the browser's storage). Its fingerprint names it. Pairing shows both fingerprints so
  you can compare them.
- **Pairing.** The desktop shows a QR code with its identity, the relay's address and a one-time
  secret that expires in five minutes. The phone answers through the relay with a request proving it
  saw the QR; you confirm the device name and fingerprint on the desktop and choose what it may do.
- **Capabilities.** A device gets only what you tick: sessions (view, chat, answer permissions,
  close, open a new one in a profile folder), pull requests, automations, health and alerts. It
  can never pick a folder outside the profile's, open windows or dialogs on the desktop, read or
  change settings, or see secrets. You can revoke a device at any time.
- **Reconnecting.** Both ends reconnect on their own after a restart or a lost connection, with the
  identity they already have. The phone keeps the last state it saw so it still shows your
  sessions, pull requests and alerts without network.
- **Notifications.** The phone can receive the same notifications the desktop shows, through Web
  Push with an encrypted body only the phone can open. On iPhone this needs the web app added to
  the home screen.

## Turning it on (Settings → Remote access)

1. **Relay address.** Type the relay you run or trust, as `https://relay.example.com`. The phone
   opens the same address, so the relay also serves the phone's app.
2. **Allow remote access.** Workhub makes this computer's identity the first time (its seed lives
   in the secret store, next to your tokens), connects to the relay and shows its fingerprint. The
   switch stays on across restarts; the connection comes back on its own after the relay or the
   network drop, backing off up to half a minute between attempts.
3. **Pair a device.** *Show QR code* puts a code on screen for five minutes. Scan it with the phone
   (or copy the link and open it there). When the phone answers, Settings shows its name, platform
   and fingerprint; compare the fingerprint with the one on the phone, tick what the device may do,
   and *Accept*. The device connects within a second and from then on reconnects by itself.
4. **Paired devices.** Each one shows whether it is connected, when it was last seen and its
   capabilities, which you can change at any time (the device reconnects with the new set).
   *Revoke* drops it: it has to pair again to come back.

Notifications the desktop shows are repeated to the devices whose capabilities cover them: over
the live connection when the device is online, by push when it is not. The push body is sealed to
the device's key, so the relay and the push service carry ciphertext. Quiet hours and the
per-kind switches apply before anything leaves the desktop.

## Self-hosting the relay

The relay is one small Node service. It keeps no messages and no accounts; the only thing it
stores is where to send push notifications for devices that asked for them.

### With Docker

```sh
mkdir workhub-relay && cd workhub-relay
curl -fsSLO https://raw.githubusercontent.com/SoldierIced/workhub/main/packages/relay/compose.yaml
curl -fsSL https://raw.githubusercontent.com/SoldierIced/workhub/main/packages/relay/.env.example -o .env
docker run --rm ghcr.io/soldiericed/workhub-relay:latest node relay.cjs --vapid   # prints VAPID keys; paste them into .env
docker compose up -d
curl -s http://127.0.0.1:8787/healthz
```

Put a reverse proxy with TLS in front (nginx, Caddy, Traefik) and forward WebSocket upgrades to
`/ws`. The desktop and the phone then use `https://relay.example.com` (the relay turns it into
`wss://relay.example.com/ws`). An nginx `location /` block needs `proxy_http_version 1.1`,
`Upgrade` and `Connection "upgrade"` headers, and a long `proxy_read_timeout`.

### Configuration

| Variable | Meaning |
|---|---|
| `PORT`, `HOST` | Where to listen (default `8787`, `0.0.0.0`). |
| `DATA_DIR` | Where push subscriptions persist (`/data` in the image). |
| `WEB_CLIENT_DIR` | Folder with the built web client to serve on `/`; unset serves none. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Enable Web Push. `node relay.cjs --vapid` prints a key pair; the subject is a `mailto:` or URL push services may contact. |
| `TRUST_PROXY` | `1` (default) reads the client address from `X-Forwarded-For`; `0` without a proxy. |

`GET /healthz` answers `{"ok":true,...}`. The relay logs who authenticated and when a push failed,
never bodies.

### Limits and what the relay sees

- Every connection authenticates in its first message with a signature over a fresh timestamp and
  is closed after ten seconds without one. Frames above 520 KB are refused; a connection that
  floods is told to slow down and closed if it keeps going; a room admits a desktop and up to 24
  devices.
- The relay sees fingerprints, which room (desktop) a device talks to, message sizes and timing,
  the IP addresses, and push endpoints. It never sees message contents, session names, folders,
  prompts or notifications: those are ciphertext between the desktop and the device.

### From source

```sh
npm ci
npm run build -w @workhub/relay         # packages/relay/dist/relay.cjs, one file
PORT=8787 node packages/relay/dist/relay.cjs
```
