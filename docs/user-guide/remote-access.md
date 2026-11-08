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
  close, open a new one in a profile folder), pull requests, automations (run, stop, turn on or
  off; a phone cannot create or edit one), health and alerts, Plan. Sessions and automations mean
  the agents run code on this computer, so grant them to phones you hold; automations start
  unticked. A device can never pick a folder outside the profile's, switch an agent to a mode that
  skips permission prompts, open windows or dialogs on the desktop, read or change settings, or see
  secrets. It gets a trimmed view of the configuration (profile names and agents, no connections or
  environment). You can revoke a device at any time; a phone that unpairs tells the desktop, which
  drops it too.
- **Reconnecting.** Both ends reconnect on their own after a restart or a lost connection, with the
  identity they already have. The phone keeps the last state it saw so it still shows your
  sessions, pull requests and alerts without network.
- **Notifications.** The phone can receive the same notifications the desktop shows, through Web
  Push with an encrypted body only the phone can open. On iPhone this needs the web app added to
  the home screen.

## Turning it on (Settings → Remote access)

1. **Relay address.** New installs come with the public relay the project runs; type another, as
   `https://relay.example.com`, to use one you host or trust. The phone opens the same address, so
   the relay also serves the phone's app.
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

## On the phone

The phone opens the relay's address in its browser: the relay serves the phone app from `/`.

1. **Pair.** Scan the QR code (or open its link). From the app installed on the home screen,
   which has no address bar, use *Copy link* on the desktop and paste it into the pairing field
   instead: a tapped link or a scanned QR opens the browser, not the installed app. The app shows
   the computer's name and fingerprint and this phone's fingerprint; give the phone a name and
   tap *Pair*. Back on the
   desktop, compare the fingerprints, tick what the phone may do and *Accept*. The phone connects
   at once and never asks again, even after the desktop, the relay or the phone restart.
2. **Notifications.** Asked once after pairing. *Allow* subscribes the browser to Web Push; the
   desktop's notifications then reach the phone with the body sealed to its key, whether or not
   the app is open. On iPhone add the app to the Home Screen first (Share → Add to Home Screen):
   Safari only delivers web notifications to installed apps. Settings on the phone turns them on
   or off later.
3. **Sessions.** The list of sessions open on the desktop, the ones waiting for an answer first.
   A session shows the chat as the desktop does: replies, tool calls, permission prompts (with the
   same options) and questions, and files the agent wrote (images preview inline, anything else
   downloads; files above 8 MB stay on the desktop). Opening a session loads its latest messages;
   scrolling up loads earlier ones a page at a time (very long tool output and pasted images stay
   on the desktop). The prompt box sends a message or stops the
   turn. *New* opens a session in one of the profile's folders, with the agent and an optional
   first message; the session appears on the desktop too.
4. **Pull requests and alerts.** The same lists the desktop shows for the profile you pick; a tap
   opens the pull request or the alert's link in the phone's browser.
5. **Plan.** With the *Plan* capability: today's and tomorrow's meetings (join the call, prepare or
   open the brief), the inbox waiting for a decision (approve, keep or discard; agents' milestone
   proposals too), the tasks you took on (done with a tap, or open one to edit it or add a note),
   and the milestones with their progress against time, pieces and notes. *+* adds a pending item.
   The calendars' addresses and the Plan settings stay on the desktop.
6. **Several computers.** One phone can pair with more than one desktop (home and work, say):
   Settings → *Pair another computer*. The phone talks to one at a time; a selector at the top of
   Sessions and the list in Settings switch between them, and a notification from another
   computer switches to it when tapped. Each desktop keeps its own cached state and its own
   capabilities. Revoking the phone on one desktop leaves the others paired.
7. **Phone settings.** Language, theme and text size are the phone's own; the profile the lists
   open with is remembered per phone.
8. **Without network.** The phone keeps the last answer to each list and the latest messages of
   each open session, encrypted with its own key, and shows them with a banner while the desktop
   is unreachable. When the app goes to the
   background it closes its connection so notifications arrive as push; back in front it reconnects.
9. **Unpair.** Settings → *Unpair this phone* forgets the current desktop and its cached state. Revoking the
   device on the desktop does the same from the other side.

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
| `TRUST_PROXY` | `1` behind a reverse proxy: the client address comes from `X-Real-IP`, or the last entry of `X-Forwarded-For` (the one the proxy appended). Off by default. |
| `PUSH_ENDPOINT_HOSTS` | Extra push-service hosts, comma separated. The browsers' own services are built in; any other endpoint is refused, so the relay cannot be pointed at arbitrary addresses. |
| `RELAY_VERSION` | Reported by `/healthz` (the image sets it to the commit). |

`GET /healthz` answers `{"ok":true,...}`. The relay logs who authenticated and when a push failed,
never bodies.

### Limits and what the relay sees

- Every connection authenticates in its first message with a signature over a nonce the relay sent
  and a fresh timestamp, so a captured login cannot be replayed; a connection is closed after ten
  seconds without one. Frames above 520 KB are refused; a connection that floods is told to slow
  down and closed if it keeps going; a peer that stops reading is dropped instead of buffered for;
  a room admits a desktop and up to 24 devices, an identity holds a few connections and an address
  a few dozen.
- Pushed notifications are signed by the desktop: the phone shows one only when it comes from a
  computer it paired with, and only while it is recent.
- The relay sees fingerprints, which room (desktop) a device talks to, message sizes and timing,
  the IP addresses, and push endpoints. It never sees message contents, session names, folders,
  prompts or notifications: those are ciphertext between the desktop and the device.

### What the relay can and cannot do

- It cannot read your traffic: messages are end-to-end encrypted between the computer and the
  phone, and the relay only forwards ciphertext.
- It does serve the phone app's code. A malicious relay operator could ship modified code that
  reads the keys stored on the phone, so only pair with a relay you trust. Self-hosting is the
  safest choice. When you confirm a pairing, check the relay host the phone shows.
- Revoking a phone from the computer (Settings → Remote access) is the authoritative way to cut its
  access. Forgetting the computer on the phone also tells the computer to drop it, when the two are
  connected at that moment.
- Set `TRUST_PROXY=1` only when the relay runs behind a reverse proxy that sets `X-Forwarded-For`.
  The relay uses the rightmost address in that header; without such a proxy, use `TRUST_PROXY=0`,
  or clients could spoof their address.

### From source

```sh
npm ci
npm run build -w @workhub/relay         # packages/relay/dist/relay.cjs, one file
npm run build:web -w @workhub/app       # the phone app, into packages/relay/web-client/
PORT=8787 WEB_CLIENT_DIR=packages/relay/web-client node packages/relay/dist/relay.cjs
```

The container image copies `packages/relay/web-client/` into `/web`, so run `build:web` before
`docker build`. `npm run dev:web -w @workhub/app` serves the phone app on port 5180 against any relay
(the pairing link names the relay); the service worker is only built by `build:web`.
