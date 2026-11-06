import { randomUUID } from 'node:crypto'
import {
  EMPTY_SESSION_GROUPS,
  effectiveAgentKey,
  parseGroupChoice,
  placeInGroup,
  resolveSessionName,
  sessionIdentity,
  type GroupMember,
  type SessionGroups
} from '@workhub/core'
import type { SessionView, StartSessionInput } from '../shared/api'

/** What a new session's member of a sidebar group is, before anything was asked in it. */
export function newSessionMember(view: SessionView): GroupMember {
  const name = resolveSessionName({ name: view.name, cwd: view.cwd })
  const member: GroupMember = { key: sessionIdentity(view), title: name.title, agentKey: effectiveAgentKey(view.agentId, view.accountId), cwd: view.cwd, agentId: view.agentId }
  if (name.titled) member.titled = true
  if (view.agentName) member.agentName = view.agentName
  if (view.accountId) member.accountId = view.accountId
  if (view.accountName) member.accountName = view.accountName
  if (view.profileId) member.profileId = view.profileId
  return member
}

interface Result {
  ok: boolean
}

export interface SessionPlacementDeps {
  start(input: StartSessionInput): Promise<SessionView>
  groups(): Promise<SessionGroups | undefined>
  saveGroups(groups: SessionGroups): Promise<Result>
  /** For a session whose agent reported its real id while its place was saved. */
  replaceIdentity(oldKey: string, newKey: string): Promise<Result | undefined>
  /** The session as it is now (its identity may have changed since it started). */
  current(id: string): SessionView | undefined
  /** Main rewrote the groups: the windows reload the config. */
  changed(): void
  newId?: () => string
}

/**
 * Starts a session (the renderer's `sessions:start`) and puts it in the group the New session
 * dialog chose. The place is saved in main, under the identity the session has right now; an
 * agent that reports its real id meanwhile (the group write raced its identity move) has the
 * place moved after it, so a quick agent never leaves its group under a stale key.
 */
export async function startPlaced(input: StartSessionInput, deps: SessionPlacementDeps): Promise<SessionView> {
  const { group, ...rest } = input
  const view = await deps.start(rest)
  const choice = parseGroupChoice(group)
  if (!choice) return view
  try {
    const member = newSessionMember(view)
    const stored = (await deps.groups()) ?? EMPTY_SESSION_GROUPS
    const next = placeInGroup(stored, member, choice, (deps.newId ?? (() => `g-${randomUUID()}`))())
    if (next === stored) return view
    const saved = await deps.saveGroups(next)
    if (!saved.ok) return view
    const now = deps.current(view.id)
    const key = now ? sessionIdentity(now) : member.key
    if (key !== member.key) await deps.replaceIdentity(member.key, key)
    deps.changed()
  } catch {
    // The group is a convenience; the session runs either way.
  }
  return view
}
