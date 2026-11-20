// The app's end of a host's control relay (`@workhub/adapters/host` control-relay.ts): a request a
// session sent to the host's socket arrives as a `control.request` event, is served by main's
// endpoint (`serveControl`, which authorizes it by the session token like any other request), and
// the answer goes back as a `control.respond` request. Reaching the host's socket (mode 0600, in a
// folder only the user can open) stands where reaching the app's socket, or its loopback token on
// Windows, does for a local session.
import { CONTROL_REQUEST_EVENT, CONTROL_RESPOND_METHOD, HostRequestError, relayedControlRequestSchema, type HostClient, type RelayedControlResponse } from '@workhub/adapters/host'
import type { ControlEndpoint, ControlRequest, ControlResponse } from './control-server'
import type { HostControlInfo } from './hosts'

/** Serves one control request in main; the endpoint's deps are bound by the caller. */
export type ControlServe = (req: ControlRequest) => Promise<ControlResponse>

const errorResponse = (rid: number, status: number, error: string): RelayedControlResponse => ({
  rid,
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ok: false, error })
})

/**
 * Answers the control requests a host relays, for as long as its client lives. `serve` is asked at
 * each request: null while main's endpoint is not up (the request gets a 503).
 */
export function answerRelayedControl(client: Pick<HostClient, 'onEvent' | 'request'>, serve: () => ControlServe | null, log: (message: string) => void): () => void {
  return client.onEvent(CONTROL_REQUEST_EVENT, (payload) => {
    const parsed = relayedControlRequestSchema.safeParse(payload)
    if (!parsed.success) return log('host: a malformed control request was dropped')
    void answer(client, parsed.data.rid, serve(), parsed.data, log)
  })
}

async function answer(client: Pick<HostClient, 'request'>, rid: number, serve: ControlServe | null, req: ControlRequest, log: (message: string) => void): Promise<void> {
  let response: RelayedControlResponse
  if (!serve) response = errorResponse(rid, 503, 'the Workhub endpoint is not available')
  else {
    try {
      const r = await serve({ method: req.method, url: req.url, headers: req.headers, body: req.body })
      response = { rid, status: r.status, headers: r.headers, body: r.body }
    } catch (err) {
      response = errorResponse(rid, 500, err instanceof Error ? err.message : String(err))
    }
  }
  try {
    await client.request(CONTROL_RESPOND_METHOD, response)
  } catch (err) {
    // An answer over the channel's line cap still tells the caller why.
    if (err instanceof HostRequestError && err.code === 'too_large') {
      await client.request(CONTROL_RESPOND_METHOD, errorResponse(rid, 502, 'the answer is too large to relay to the host; ask for less (a smaller page or query)')).catch(() => {})
      return
    }
    log(`host: a control answer was not delivered: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * The endpoint a session gets, by its host's `control`: main's own (undefined: this computer), the
 * host's relay socket while main can serve what it relays, or none (null, or main not up yet).
 */
export function sessionEndpoint(control: HostControlInfo | null | undefined, local: ControlEndpoint | null, relaying: boolean): ControlEndpoint | null {
  if (control === undefined) return local
  return control && relaying ? { socket: control.socket } : null
}

/** Where Workhub's MCP server runs for a session: on its host (the host's Node and bridge), else with the app's. */
export function mcpLaunchTarget(control: HostControlInfo | null | undefined, local: { node: string; script: string }): { node: string; script: string } {
  return control ? { node: control.node, script: control.mcpScript } : local
}
