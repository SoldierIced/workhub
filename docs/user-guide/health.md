# Health

The **Health** screen (⌘/Ctrl+8) shows, for each environment, the errors, pods and slow endpoints
of your services, read from Elasticsearch (Elastic APM and Kubernetes metrics). Nothing is called
healthy unless it could be read. It is an optional module: turn on **Health** for the profile in
**Settings → Profiles**.

## Set up

In **Settings → Health**:

1. **Elasticsearch URL**: `https` only (`http` is accepted for localhost).
2. **Authentication**: **API key** or **Username and password**. Use a read-only key or user. The
   secret is stored encrypted, never in the settings file.
3. **TLS certificate**: **System trust store**, **Pin one certificate** (give its SHA-256
   fingerprint; use this for a self-signed certificate) or **No validation** (only on a network you
   trust).
4. **Refresh every**: how often the screen reads. A global floor (**Never more often than**) applies
   to every profile, Refresh included, so a shared cluster is not overloaded.
5. **Test connection**, then **Save connection**.
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

Below, per environment: **Errors by service** (each marked **New**, **Worsening**, **Ongoing** or
**Chronic**; chronic signals are listed but never alert), **Pods**, **Kubernetes warnings**, **APM
agents** (services that went silent), **Slow endpoints** (slowest p95 first, with a span breakdown
and a comparison with the previous window), and **Container stderr** as a rough proxy when pod
metrics are missing. **Show details** expands a row.

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

**Rules.** Each metric is compared with its own previous 7 business days. Every limit is a
default in **Settings → Health → Alert rules** and can be overridden per metric id.

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
later day opens a fresh alert. The list is ordered by severity, then date, and filters by rule,
severity and status. Home shows an **Alerts** card with the open count and the top high-severity
ones.

**Send to inbox.** When the profile has the [Plan](plan.md) module on, an open alert also offers
**Send to inbox**: it adds a pending **bug** to Plan's inbox with the alert's metric, subject,
values, period and link, and a new alert becomes tracked. It never creates a ticket by itself: the
item waits under **To review** for you to choose **Create ticket** (which creates the issue), **Local
task**, or discard it.
Sending the same alert again while its item is open does not add a second one.

**Settings → Health → Alert rules** holds the thresholds, the business days, the minimum severity
that notifies (default high) and the per-metric overrides (minimum volume, jump percentage, rate
points, critical, muted). With `WORKHUB_DEMO_HEALTH=1` the tab shows a month of synthetic product
metrics with one alert of each kind; the demo never notifies.

## Notifications

**Settings → General → Other notifications → Health**: an environment degrades, cannot be reached
or recovers, a service stops reporting, a pod stops being ready, an error signal starts worsening.
The top navigation and the menu bar panel show the state too.

**Settings → General → Other notifications → Metric alerts**: a metric alert opens or escalates at
or above the profile's minimum severity. Snoozed alerts stay quiet; several at once arrive as one
notification. A click opens the Alerts tab.

Problems connecting? See [Troubleshooting](../troubleshooting.md#health-is-unreachable-or-returns-401).

Next: [Automations](automations.md).
