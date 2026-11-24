// Where a profile's sessions and folders live: this computer, or a WSL distribution (whose folders
// are POSIX paths inside it). A profile without one runs on this computer.
import type { AgentDefinition } from '../domain/agent'
import type { Profile } from '../domain/profile'

export type ProfileHost = { kind: 'local' } | { kind: 'wsl'; distro: string }

/** The host a profile runs on; this computer when it names none. */
export function hostOfProfile(profile: Pick<Profile, 'host'>): ProfileHost {
  return profile.host ?? { kind: 'local' }
}

/** A stable id for a host, the one the app registers it under: `local`, or `wsl:<distro>`. */
export function hostIdOf(host: ProfileHost): string {
  return host.kind === 'wsl' ? `wsl:${host.distro}` : 'local'
}

/**
 * Whether an agent can start: installed (true) or not (false) on this computer; on a WSL host,
 * `pending` while the host has not connected, and `unsupported` for an agent sessions there cannot
 * run yet.
 */
export type AgentAvailability = boolean | 'pending' | 'unsupported'

/**
 * The agents a profile on a WSL host can start: Claude Code (the host brings its own, so it is there
 * once the host connects); the other agents and shells do not run in WSL yet.
 */
export function hostAgentAvailability(agents: readonly Pick<AgentDefinition, 'id' | 'adapter'>[], connected: boolean): Record<string, AgentAvailability> {
  return Object.fromEntries(agents.map((a) => [a.id, a.adapter !== 'native' ? 'unsupported' : connected ? true : 'pending']))
}
