# Health

The **Health** screen (⌘/Ctrl+8) shows, for each environment, the errors, pods and slow endpoints
of your services, read from Elasticsearch (Elastic APM and Kubernetes metrics). Nothing is called
healthy unless it could be read. It is an optional module: turn on **Health** for the profile in
**Settings → Profiles → (profile) → Screens**.

## Set up

In **Settings → Profiles → (profile) → Screens → Health** (open the row):

1. **Elasticsearch URL**: `https` only (`http` is accepted for localhost).
2. **Authentication**: **API key** or **Username and password**. Kibana shows the API key already
   encoded, or as `id:api_key`; paste either one. Use a read-only key or user. The secret is stored
   encrypted, never in the settings file.
3. **TLS certificate**: **System trust store**, **Pin one certificate** (give its SHA-256
   fingerprint; use this for a self-signed certificate) or **No validation** (only on a network you
   trust).
4. **Refresh every**: how often the screen reads. A global floor (**Never more often than**) applies
   to every profile, Refresh included, so a shared cluster is not overloaded.
5. **Test connection**, then **Save connection**. The test reads the cluster root. When an
   environment already names an index, it also counts the documents in that index.
6. **Environments**: add each one (production, staging…) with its `service.environment` values
   (comma separated, for example `prod, production`, because services do not always tag the same
   way), its APM errors, traces and metrics indexes (or **Use Elastic's default data streams**), the
   **Kubernetes index suffix**, whether it **Ships kube-state metrics**, and an optional **Kibana
   URL** that adds Kibana buttons. **Thresholds** decide when something is flagged.

All queries are read-only aggregations. Error trends are cached for 30 minutes and slow endpoints
for an hour.

## Reading the screen

Each environment has one of four states:

| State | Meaning |
|---|---|
| **Healthy** | Every signal that could be read is quiet. |
| **Degraded** | Something needs attention: pods not ready or crash-looping, new or worsening errors, services that stopped reporting. |
| **Blind** | Part of the picture is missing (for example no Kubernetes metrics), so it cannot be called healthy. **Blind spots** says what is missing. |
| **Unreachable** | Elasticsearch could not be reached. |

Under the tabs, one row holds the environments (a dot shows each one's state), a summary (how
many services, how many favorites, the error window), **Select** and **Only favorites**. Each
environment is a board, worst services first:

- **Favorites**: the services you starred, as large cards: state (**Healthy**, **Degraded**,
  **Erroring**, **Pods failing**, or **No data** when errors could not be read), the errors in the
  window with the typical day under them, and a chart of errors per day: one bar per day of the
  trend window, the last one the rolling window in the card's color, a dashed line at the typical
  day (hover a bar for its day and count). When the color comes from something other than errors
  (a pod not ready or crash-looping, a silent agent) the card says so under the number. A line of
  facts follows: the trend (**New**, **Worsening**, **Ongoing** or **Chronic**; chronic signals are
  listed but never alert), the p95 of the service's slowest endpoint, its pods that need attention
  and its open metric alerts. **Investigate with Claude** is the icon at the top right.
- **All services**: every other service a signal names (errors, silent APM agents, slow endpoints),
  as small cards with the same chart. The star on any card adds or removes the favorite; favorites
  are kept per profile and show in every environment.
- A click on a card opens its details in a sheet at the right, over the board, so the cards stay
  where they are and another card can be picked without closing it. The sheet shows a sentence
  that sums the service up, its errors per day, its error groups with their share, its slow
  endpoints (a click on one shows the span breakdown and a comparison with the previous window),
  and its pods and agent, with the Kibana link and Investigate at the top. Drag the sheet's left
  edge to resize it (a double click goes back to the usual width) or use the widen button; the
  width is remembered. **Esc** or the cross closes it.
- **Slow endpoints**: the four slowest, one per row on a shared scale: a bar from p50 to p95 and a
  tick at p99, with calls and the failure share. **See all** opens the whole list under them, each
  row with its details.
- **Environment**: the verdict with its reasons and blind spots and **Open in Kibana**. Blocks with
  nothing to report (no pods needing attention, no Kubernetes warnings, every APM agent reporting)
  are one muted line under it; **Pods**, **Kubernetes warnings**, **APM agents** and **Container
  stderr** (a rough proxy when pod metrics are missing) get a card when they have something to
  show. **Show details** expands a row.

The header's **Refresh** reads the environments again.

## Investigate with an agent

**Investigate with Claude** opens a Claude session with a summary of the signal as a draft; nothing
is sent. **Select** lets you pick several signals and **Investigate together with Claude**. The
session opens in the matching folder of the profile, else in its default folder.
**Copy request for infra** copies a message you can paste to your infra team, asking for kube-state metrics when they are missing.

## Alerts

The **Alerts** tab turns daily metrics into alerts that last: one alert per metric and subject,
updated while the problem lasts instead of a new notification every hour. The engine does not
care where a number comes from; today the source is Health itself (no extra queries): errors per
service, stderr lines per container, calls to the slow endpoints per service and their failure
rate, one value per day (the last read of the day, a rolling 24 h figure). Series keep 45 days.
The engine also records which days each source was actually read. A count that only lists what
happened (errors, stderr lines, slow calls) counts as zero on a day it was read with nothing for
that subject; a day it was not read (the app closed, the environment unreachable, a signal that
could not be read) is left out of the baseline and the sparkline, so coming back after a week away
does not turn a normal day into a jump.

**Rules.** Each metric is compared with its own previous 7 business days. Every limit is a
default in **Settings → Profiles → (profile) → Screens → Health → Alert rules** and can be overridden per metric id.

| Rule | Fires when | Default |
|---|---|---|
| Jump | The day is above the average by a percentage, or several standard deviations away | 50%, 2 std devs |
| Sustained trend | The metric gets worse several business days in a row and ends above the average | 3 days, 20% |
| New subject | A subject appears for the first time in a number of days | 30 days |
| Rate change | A percentage moves the bad way by a number of points | 5 points |
| Missing data | A metric that reports daily has no sample for 24 h on a business day | |

Nothing alerts below the minimum daily volume (default 20; for a rate, its base). Metrics have a
direction: for a metric where down is bad (sign-ups, conversion) only drops alert. Business days
default to Monday to Friday. Severity is **high** for a jump above twice the jump percentage, a rate
change above twice its points, or any alert on a metric marked critical; **medium** for sustained
trends, new subjects and other jumps or rate changes; **low** near a threshold (80% of it) or for
missing data. A new source needs a week of history before new subjects are announced.

**Lifecycle.** A new alert is **New**. **Track** says you are on it; **Snooze** hides it for 7 or 30
days, or until the trend changes (another rule fires or the severity rises); **Resolve** closes it
and **Reopen** brings it back. While an alert is open its values, sparkline (last 14 days) and
severity update; severity only goes up. After 3 business days without a detection the row offers
**Looks back to normal. Resolve?**. Resolved alerts disappear after 7 days; the same problem on a
later day opens a fresh alert.

**Cards and list.** Alerts show as cards by default: the change in the severity's color with the
day's value against the baseline, the last 14 days as a line over a grey band (the range of the 7
values before the last), the status and **Resolve** (**Reopen** once resolved). The star pins an
alert: pinned alerts come first as large cards, with **To the inbox** next to Resolve; the rest
follow by severity. The other actions (open the source, Track, Send to inbox, Snooze, Reopen) are in
the card's **⋯** menu. **List** shows the compact rows instead. **Filters** holds the status,
severity and rule filters; each one set shows as a chip that clears it. **Only pinned** hides the
rest, and the refresh icon checks now. Pins, the layout and Only pinned are remembered. Home shows an **Alerts** card with the open count and the top high-severity
ones.

**Send to inbox.** When the profile has the [Plan](plan.md) module on, an open alert also offers
**Send to inbox**: it adds a pending **bug** to Plan's inbox with the alert's metric, subject,
values, period and link, and a new alert becomes tracked. It never creates a ticket by itself: the
item waits under **To review** for you to choose **Create ticket** (which creates the issue), **Local
task**, or discard it.
Sending the same alert again while its item is open does not add a second one.

**Settings → Profiles → (profile) → Screens → Health → Alert rules** holds the thresholds, the business days, the minimum severity
that notifies (default high) and the per-metric overrides (minimum volume, jump percentage, rate
points, critical, muted). With `WORKHUB_DEMO_HEALTH=1` the tab shows a month of synthetic product
metrics with one alert of each kind; the demo never notifies.

## Notifications

**Settings → Notifications and alerts** (Health and metrics): an environment degrades, cannot be reached
or recovers, a service stops reporting, a pod stops being ready, an error signal starts worsening.
The top navigation and the menu bar panel show the state too.

**Settings → Profiles → (profile) → Screens → Health → Health · environments** decides, per profile and per kind of alert, whether
it is announced and where: **Notification** (the OS notification) and **Menu bar** (the menu bar's
recent notifications). A kind turned off still shows on the Health screen. Two kinds take a
threshold of their own: **A service stops reporting** (announced once it has been silent that many
minutes; below the environment's *stopped reporting after* it changes nothing) and **Errors start
worsening** (announced from that many times its typical day). Pods and the environment changes
have no threshold to tune (shown as —). Left blank, the environment's thresholds decide, as before.
The same screen holds the metric alerts' minimum severity and business days (the per-metric
overrides stay in Settings → Profiles → (profile) → Screens → Health → Alert rules) and the profile's **Quiet hours**.

**Quiet hours** (Settings → Profiles → (profile) → Screens → Health, per profile, may cross midnight, such as 22:00 to 07:00):
Health, flow-map and metric alert notifications are not shown during them. They are still
recorded and cooled down, so they do not all arrive when the quiet hours end. Session and meeting
notifications are never held back.

**Settings → Notifications and alerts** (Health and metrics, metric alerts): a metric alert opens or escalates at
or above the profile's minimum severity. Snoozed alerts stay quiet; several at once arrive as one
notification. A click opens the Alerts tab.

Problems connecting? See [Troubleshooting](../troubleshooting.md#health-is-unreachable-or-returns-401).

Next: [Automations](automations.md).
