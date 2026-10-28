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

## Notifications

**Settings → General → Other notifications → Health**: an environment degrades, cannot be reached
or recovers, a service stops reporting, a pod stops being ready, an error signal starts worsening.
The top navigation and the menu bar panel show the state too.

Problems connecting? See [Troubleshooting](../troubleshooting.md#health-is-unreachable-or-returns-401).

Next: [Automations](automations.md).
