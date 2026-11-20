# Remote access

Workhub Remote lets a phone (or any browser) see and drive the Workhub on your desktop: the
sessions that are running, their chat, permission prompts (pinned above the message box until
answered, like on the desktop; when the agent's own console is the one asking, the phone says so
and the answer is given on the desktop), pull requests and
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
  saw the QR, and then shows a 6-digit pairing code; you type that code on the desktop and choose
  what the device may do. Anyone who saw the QR (a screen share, a photo) knows its secret, but not
  the code your phone shows: their device gets another code, and a wrong code cancels the
  request. If a second device answers the same QR, the desktop cancels it and tells you.
- **Capabilities.** A device gets only what you tick: sessions (view, chat, answer permissions,
  close, open a new one in a profile folder, see what a session changed and answer its review loop), pull requests (read-only lists), automations (their notifications, and an Automations screen to run one, stop a run and turn one off), health and alerts, Plan. A device
  can call only what the phone app itself uses: it cannot review, comment on or close a pull request, or create, edit, remove or turn on an automation, whatever it was granted.
  Sessions mean the agents run code on this computer, so grant them to phones you hold; automations
  start unticked. A device can never pick a folder outside the profile's, open windows or dialogs
  on the desktop, read or change settings, or see secrets. It never starts a session in a mode that
  skips permission prompts: when the account's or the agent's default mode is one, a session
  started from the phone runs in the agent's safest mode that asks (Default for Claude Code), and
  an agent with no such mode is refused until you start it on the desktop. It gets a trimmed view of the configuration (profile names and agents, no connections or
  environment). You can revoke a device at any time; a phone that unpairs tells the desktop, which
  drops it too.
- **Reconnecting.** Both ends reconnect on their own after a restart or a lost connection, with the
  identity they already have. The phone keeps the last state it saw so it still shows your
  sessions, pull requests and alerts without network. A connection that goes silent without
  closing (the network changed, the phone slept) is noticed within about 30 seconds and dialed
  again; one stuck connecting for 15 seconds is retried too.
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
   and fingerprint, and the phone shows a 6-digit pairing code. Type the code in Settings, tick what
   the device may do, and *Accept* (it stays disabled until six digits are typed). The device
   connects within a second and from then on reconnects by itself.
   - A wrong code cancels the request and the QR: show a new one and start again.
   - If a second device answers the same QR, pairing is cancelled and Settings says so: someone
     else may have seen the code or its link. Show a new QR only to your phone.
   - A phone still running the app from before pairing codes cannot show one; Settings asks you
     to reload the page on the phone, then open the link again. A phone that opens a QR from an
     older Workhub says the computer needs an update.
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
   tap *Pair*. The phone then shows a 6-digit pairing code. Back on the desktop, type that code,
   tick what the phone may do and *Accept*. Do not read the code out or share it: whoever types
   it on the computer pairs this phone. The phone connects at once and never asks again, even
   after the desktop, the relay or the phone restart.
2. **Notifications.** Asked once after pairing. *Allow* subscribes the browser to Web Push; the
   desktop's notifications then reach the phone with the body sealed to its key, whether or not
   the app is open. On iPhone add the app to the Home Screen first (Share → Add to Home Screen):
   Safari only delivers web notifications to installed apps. Settings on the phone turns them on
   or off later.
   A notification that a session waits on one permission request can show a **Deny** button where
   the browser draws buttons on notifications: Chrome and Edge on Android, Windows, macOS and
   Linux (on macOS, Chrome may put them under *Options*). A tap on **Deny** answers that request
   without opening the app; a tap on the notification itself opens the session as before. There is
   no **Allow** button: Workhub cannot tell a harmless request from a dangerous one, so allowing
   stays in the app, where you see the whole request. No button is shown when several requests
   wait in the session, for a question with choices, or when the agent offers no way to deny.
   Safari (on iPhone and on the Mac) and Firefox do not draw notification buttons, so their
   notifications behave as before; this was not checked on every device. The answer is refused,
   and the phone says so in a new notification you can tap to open the session, when the request
   was already answered or withdrawn, the notification is more than ten minutes old, its button was
   already used, or the computer cannot be reached.
3. **Sessions.** The sessions as the desktop's sidebar lists them: the same order, groups and
   sub-groups (a group collapsed on the desktop starts collapsed; a tap opens or closes it on the
   phone only), and the same rows: the agent's icon with its state dot, the profile's colour bar,
   the account, folder and state, and a glyph for what it is up to (a spinner while it works, a
   question mark while it waits for you). A group's header shows the most urgent state inside it.
   Closed members of a group are listed dimmed; a tap reopens them. A session's sub-agents (those
   at work, and those that ended in the last few minutes) are listed under its row, open while one
   runs; a tap opens the sub-agent's conversation: what it was asked, its steps and its answer (its
   oldest steps and tool output stay on the desktop when it is long). A Task call in the chat opens
   its sub-agent too. Leaving a chat brings the list back where it was, and a chat always opens at
   its latest message.
   A session shows the chat as the desktop does: replies, tool calls, permission prompts (with the
   same options) and questions, and files the agent read or wrote in the session's folder. **Open** on a
   file fetches it from the computer and shows it in the chat: an image, a Markdown document with its
   formatting, or any other text (a log, source code, JSON) as it is, in a box that scrolls until you
   tap **Expand**. Text longer than 256 KB, and anything that is not text or an image (a PDF, an
   archive), only downloads; files above about 290 KB (what fits one relay frame once encoded) stay on the computer and show "too large to open on the phone". An image outside the folder opens too when
   the session's agent read or wrote it, such as a screenshot you gave it; other files outside do not. Opening a session loads its latest messages;
   scrolling up loads earlier ones a page at a time (very long tool output and pasted images stay
   on the desktop). Under the chat, in this order: a row that says how many of the session's
   sub-agents are at work and names them (a tap on a name opens that sub-agent; it goes away when
   none runs or the session stopped); a line counting the tasks the agent left running in the
   background (a command, a watcher), which a tap opens into the desktop's notice with what each
   does and for how long it has run; the pinned permission requests; then the prompt box. The
   first three share at most about half the screen and scroll on their own. Sub-agents and
   background tasks are read from the desktop each time the phone connects, so they show (and
   finished ones stop showing as running) even when they changed while it was away. The prompt
   box sends a message or stops the
   turn; what you send shows in the desktop's chat as your message too. *New* opens a session in one of the profile's folders, with the agent and an optional
   first message; the session appears on the desktop too.
   The **Changes** icon at the top of a session shows what it changed: the same changes as the
   desktop's [review before a pull request](review-before-pr.md), read only. Pick *Branch vs base* or
   *Uncommitted only*; each repository the session touched lists its branch, and each changed file
   its status and the lines added and removed, a page at a time (*Load more*). A tap on a file shows
   its diff, again a page at a time; very long lines are cut (the computer shows them whole). A
   binary or too-large file, and hidden files or key-like names (`.env`, `id_rsa`), show a notice
   instead of their content. The phone can only open files from that list. When the session has a
   review loop, its state shows at the top of Changes; while it waits for you, the chat shows it
   too, with the decisions the desktop offers at that point: **Continue** or **Stop review** for a
   paused *Review before PR*, and for a *Review with another agent* loop the findings to send to the
   author (with an optional note) or **Stop loop**. Everything else (comments on lines, finding
   states, starting a review) stays on the computer.
   The search icon at the top of Sessions (a *Search sessions* box) searches the computer's History (see
   [History](history.md#find-and-filter)), limited to sessions run in the folders of the profile
   the phone has picked, the same folders it may open a session in. Results come best match first
   with the text around each match, a page at a time (*Show more*); they open on the computer, not
   on the phone. The search runs again when the computer comes back online.
4. **Pull requests and alerts.** The same lists the desktop shows for the profile you pick; a tap
   opens the pull request or the alert's link in the phone's browser. Both lists of pull requests
   show at once with how many each holds; a long one comes a page at a time, with *Show more*
   under it (it waits while the desktop is unreachable).
5. **Plan.** With the *Plan* capability: today's and tomorrow's meetings (join the call, prepare or
   open the brief), the inbox waiting for a decision (approve, keep or discard; agents' milestone
   proposals too), the tasks you took on (done with a tap, or open one to edit it or add a note),
   and the milestones with their progress against time, pieces and notes. A milestone counted from a
   tracker query that is *Late* or *At risk* says why in one line (how many tickets are open, how many
   have no owner, have not moved in a week or were added after the start); a control with the number of
   open tickets opens their list, asked from the computer when you open it and again whenever the
   computer counts the milestone again. The milestone says when it was last counted; when the computer
   does not know its open tickets yet (never counted, counted by an older version, or the query
   changed), the list says so and that it is counted again on the computer, instead of saying none are
   open. Each row has the key, the
   title, a badge per reason, who has it and when it was last updated; tap it to open the ticket in the
   phone's browser. Past the first 50 it says how many more there are and links to the search in the
   tracker. The query itself is behind *Show the tracker query*. *+* adds a pending item.
   The calendars' addresses and the Plan settings stay on the desktop.
6. **Automations.** With the *Automations* capability, a tab lists the computer's automations: name,
   state (off, idle, waiting, paused, failing, running), the last run with how it ended, and when it
   runs next. *Run now* starts one that is on (it counts against the same budget of new agent runs per
   minute as starting a session from the phone), *Stop* ends a run in progress, and the switch turns an automation off.
   The phone never turns one on, and never runs one that is off: an agent can add or edit
   automations (they are always saved off), so you review and turn them on at the computer, in
   Automations. Prompts, folders and agents stay on the computer. The computer must be on a version
   with this screen; an older one says so.
   A session's chat also shows its permission mode (read-only) under the header: the mode the
   session really runs in, tinted while tools run without asking.
7. **Several computers.** One phone can pair with more than one desktop (home and work, say):
   Settings → *Pair another computer*. The phone talks to one at a time; a selector at the top of
   Sessions and the list in Settings switch between them, and a notification from another
   computer switches to it when tapped. Each desktop keeps its own cached state and its own
   capabilities. Revoking the phone on one desktop leaves the others paired.
8. **Phone settings.** Language, theme and text size are the phone's own; the profile the lists
   open with is remembered per phone.
9. **Without network.** The phone keeps the last answer to each list and the latest messages of
   each open session, encrypted with its own key, and shows them with a banner under the header
   while the desktop is unreachable (after a second and a half, so a quick reconnect does not
   flash it). When the app goes to the
   background, notifications arrive as push at once; the connection itself stays for 30 seconds,
   so a quick look at another app or the Control Center does not reconnect. After that it closes,
   and back in front it reconnects.
10. **Unpair.** Settings → *Unpair this phone* forgets the current desktop and its cached state. Revoking the
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

With `TRUST_PROXY=1`, the proxy must set the address header itself, replacing whatever the client
sent. The relay reads only that one header, and only its last entry:

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 1h;
}
```

```caddy
relay.example.com {
    # Caddy replaces X-Forwarded-For with the client's address unless you list trusted proxies.
    reverse_proxy 127.0.0.1:8787
}
```

Behind a CDN or another proxy in front of yours, `$remote_addr` is that proxy's address: configure
the proxy to pass the real one, or every client shares one bucket.

### Configuration

| Variable | Meaning |
|---|---|
| `PORT`, `HOST` | Where to listen (default `8787`, `0.0.0.0`). |
| `DATA_DIR` | Where push subscriptions persist (`/data` in the image). |
| `WEB_CLIENT_DIR` | Folder with the built web client to serve on `/`; unset serves none. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Enable Web Push. `node relay.cjs --vapid` prints a key pair; the subject is a `mailto:` or URL push services may contact. |
| `TRUST_PROXY` | `1` behind a reverse proxy: the client address comes from the last entry of one header (`X-Forwarded-For` unless `TRUST_PROXY_HEADER` says otherwise), the one the proxy appended. No other header is read. Off by default. |
| `TRUST_PROXY_HEADER` | The header your proxy sets with the client address, for example `X-Real-IP` if the proxy sets only that. Default `x-forwarded-for`. |
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
- A **Deny** tapped on a notification reaches the computer over a short connection the phone's
  service worker opens with the phone's identity: one answer sealed to the computer and signed by
  the phone, naming the request and a one-time ticket from the push. The relay sees a short
  connection and one message, not the answer.
- The relay sees fingerprints, which room (desktop) a device talks to, message sizes and timing,
  the IP addresses, and push endpoints. It never sees message contents, session names, folders,
  prompts or notifications: those are ciphertext between the desktop and the device.

### What the relay can and cannot do

- It cannot read your traffic: messages are end-to-end encrypted between the computer and the
  phone, and the relay only forwards ciphertext.
- It does serve the phone app's code. A malicious relay operator could ship modified code that
  reads the keys stored on the phone, so only pair with a relay you trust. Self-hosting is the
  safest choice. When you confirm a pairing, check the relay host the phone shows.
- The phone's key is kept in the browser's storage for the relay's address (the page reads it
  from local storage and the service worker from IndexedDB), and it can be copied: any script
  served from that address can read it. It is not yet held as a key the browser refuses to
  export. Use a relay address that serves nothing but Workhub Remote.
- Revoking a phone from the computer (Settings → Remote access) is the authoritative way to cut its
  access. Forgetting the computer on the phone also tells the computer to drop it, when the two are
  connected at that moment.
- Set `TRUST_PROXY=1` only when the relay runs behind a reverse proxy that sets `X-Forwarded-For`
  (or the header named in `TRUST_PROXY_HEADER`). The relay uses the rightmost address in that
  header and ignores every other header; without such a proxy, use `TRUST_PROXY=0`, or clients
  could spoof their address. Per-address limits count an IPv6 client by its /64, not its full address.

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
