/**
 * Connection registry (PLAN section 4, "Configuration"): named connections to external services.
 * Secrets never live in the connection; `secretRef` points into the SecretStore.
 */

export const CONNECTION_KINDS = ['codeHost', 'tracker', 'chat', 'health'] as const
export type ConnectionKind = (typeof CONNECTION_KINDS)[number]

export interface Connection {
  id: string
  kind: ConnectionKind
  /** Provider id from the provider catalog, e.g. `github`, `jira`. */
  provider: string
  /** Display name; the id is shown when empty. */
  name?: string
  /** Base URL of the service, when the provider needs one (self-hosted Jira, Elastic APM). */
  endpoint?: string
  /** Key of the secret in the SecretStore (token, API key). */
  secretRef?: string
  /** Provider-specific settings (scopes, project keys, index patterns). */
  settings: Record<string, string>
}

export interface ConnectionProvider {
  id: string
  kind: ConnectionKind
  name: string
  /** A token or key is mandatory: the connection needs a `secretRef`. */
  requiresSecret: boolean
  /** The connection needs an `endpoint`. */
  requiresEndpoint: boolean
  /** Used when `endpoint` is empty and the provider has a public default. */
  defaultEndpoint?: string
  /** Implemented in a later phase; listed so configs can be prepared ahead. */
  phase: string
}

/** Providers Workhub plans to support. GitHub and GitLab read through the `gh`/`glab` login: no secret of their own.
 *  Adapters arrive in the phase listed (PLAN section 5). */
export const CONNECTION_PROVIDERS: readonly ConnectionProvider[] = [
  { id: 'github', kind: 'codeHost', name: 'GitHub', requiresSecret: false, requiresEndpoint: false, defaultEndpoint: 'https://api.github.com', phase: 'P3' },
  { id: 'gitlab', kind: 'codeHost', name: 'GitLab', requiresSecret: false, requiresEndpoint: false, defaultEndpoint: 'https://gitlab.com', phase: 'P3' },
  { id: 'jira', kind: 'tracker', name: 'Jira', requiresSecret: true, requiresEndpoint: true, phase: 'P4' },
  { id: 'linear', kind: 'tracker', name: 'Linear', requiresSecret: true, requiresEndpoint: false, defaultEndpoint: 'https://api.linear.app', phase: 'P4' },
  { id: 'github-issues', kind: 'tracker', name: 'GitHub Issues', requiresSecret: true, requiresEndpoint: false, defaultEndpoint: 'https://api.github.com', phase: 'P4' },
  // Slack is read through the agent's own MCP server, as in Workhub 1: no token in Workhub.
  { id: 'slack', kind: 'chat', name: 'Slack (via agent MCP)', requiresSecret: false, requiresEndpoint: false, phase: 'P6' },
  { id: 'elastic-apm', kind: 'health', name: 'Elastic APM', requiresSecret: true, requiresEndpoint: true, phase: 'P6' },
  { id: 'sentry', kind: 'health', name: 'Sentry', requiresSecret: true, requiresEndpoint: false, defaultEndpoint: 'https://sentry.io', phase: 'P6' }
]

export function findProvider(id: string): ConnectionProvider | undefined {
  return CONNECTION_PROVIDERS.find((p) => p.id === id)
}

export function providersOfKind(kind: ConnectionKind): ConnectionProvider[] {
  return CONNECTION_PROVIDERS.filter((p) => p.kind === kind)
}

/** The SecretStore key Workhub uses for a connection's secret. */
export function connectionSecretRef(connectionId: string): string {
  return `connection/${connectionId}`
}
