# Slack

The Slack screen (⌘/Ctrl+4) shows the latest messages of the channels you watch and the threads you
follow. It is read-only, and it needs no Slack app and no Slack token: Workhub asks one of your
Claude accounts, through that account's own Slack connector, for new messages and new replies. Tools
that post or change anything are refused.

It is an optional module. Turn on **Chat watcher** for the profile in **Settings → Profiles**, then
turn on the watcher itself. **Watch Slack is off by default**, and nothing is read until you turn it
on.

## Set up the watcher

In **Settings → Slack**:

| Setting | Meaning |
|---|---|
| **Watch Slack** | The switch. Off by default. |
| **Claude account** | The account whose Slack connector reads the channels. Its plan usage pays for each read. |
| **Model for the reads** | A small model, like `haiku` (the default), costs the least. |
| **Every (minutes)** | Read interval; the minimum is 3 minutes, the default 10. |
| **Skip reads above this 5 h usage (%)** | Reads pause while the account's usage is this high (default 85). |
| **Hours**, **Days** | Reads only run inside these hours and on these days (default 9 to 19, Monday to Friday). |
| **Channels** | **Channel id** (like `C0123…`, from the channel details in Slack), a **Name** to show and what it is for (for example `PR reviews`); the purpose is given to the agent as context. |

The screen's header shows the state (**Off**, **Watching**, **Reading…**, **Paused**, **Failing**),
the next read, and **Read now**. Reads also wait when the account is past a usage ceiling; see
[Usage and budgets](usage.md).

## Followed threads

A followed thread shows its replies, whether there are new ones (**New**) and which session owns it.

- **Follow a thread**: paste a Slack message link and press **Follow**, or use **Track a link…**
  to also set a title, a pull request, a ticket and a session, and whether replies wake the session.
  The same **Track a Slack link** action is on a pull request's **Slack** tab.
- **Follow automatically**: with the tracking hook installed, every Slack message a Claude session
  sends is recorded, and Workhub follows its thread. **Settings → Slack → Tracking hook →
  Install** adds one `PostToolUse` entry to that account's Claude `settings.json` (a `.bak` copy is
  kept); **Remove** takes out only that entry. Nothing is edited until you click Install.
- **Wake the session**: new replies are typed into the owning session when it is idle. **Send the
  replies to the session now** forces it. If a session is not woken, the notice says why: its
  automation is off or takes no replies, the session is open in another terminal, it failed to open,
  or its account is past its usage ceiling (the replies wait).
- **Stop following** / **Follow again**. A thread is dropped from following when its pull request
  merges or closes, or after a week without activity (**Not followed**).
- **Archived (n)**: threads quiet for a while fold into **Archived**, on this screen and in the
  session monitor. Set the delay in **Settings → Profiles → Slack** (default 15 minutes). Archived
  threads are still watched, and a new reply brings them back.

## Links open in the Slack app

On macOS, a Slack message link opens in the Slack desktop app (through a `slack://` deep link) when
the app is installed and Workhub knows the workspace; otherwise it opens in the browser chosen for
the profile. **Open in Slack** on a thread uses this.

## Notifications

**Settings → General → Other notifications → Slack** controls notifications for watched channels,
replies in tracked threads and watcher failures.

Next: [Health](health.md).
