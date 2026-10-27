/**
 * Sidebar session groups ("folders" of sessions). Pure functions over a plain value that is stored
 * in the config, so the UI, the main process and later automations share one set of rules.
 *
 * A member is keyed by the session's stable identity (the agent's own session id: it survives a
 * resume and the hand-over between app and terminal mode), never by a UI or console id. Membership
 * is not tied to a session being open: a closed member stays in its group until the user removes
 * it, and a session that is reopened appears at its stored place.
 */

/** What a group remembers about a member, to list and reopen it while it is closed. */
export interface GroupMember {
  /** The session's stable identity; see `sessionIdentity`. */
  key: string
  /** What the sidebar shows while the session is closed. */
  title: string
  /** `effectiveAgentKey(agentId, accountId)` of the agent that ran it. */
  agentKey: string
  cwd: string
}

export interface SessionGroup {
  id: string
  name: string
  collapsed: boolean
  /** In the order shown. */
  members: GroupMember[]
}

/** One top-level row: a group, or a session outside any group. */
export type TopSlot = { kind: 'group'; id: string } | { kind: 'session'; key: string }

export interface SessionGroups {
  groups: SessionGroup[]
  /** Top-level order, groups and ungrouped sessions interleaved. */
  top: TopSlot[]
}

export const EMPTY_SESSION_GROUPS: SessionGroups = { groups: [], top: [] }

/** The stable identity of a session: its agent's session id, else the one Workhub assigned at start. */
export function sessionIdentity(s: { id: string; identity?: string; agentSessionId?: string }): string {
  return s.agentSessionId ?? s.identity ?? s.id
}

const same = (a: TopSlot, b: TopSlot): boolean => (a.kind === 'group' ? b.kind === 'group' && a.id === b.id : b.kind === 'session' && a.key === b.key)
const sessionSlot = (key: string): TopSlot => ({ kind: 'session', key })
const groupSlot = (id: string): TopSlot => ({ kind: 'group', id })

export function groupOf(state: SessionGroups, key: string): SessionGroup | undefined {
  return state.groups.find((g) => g.members.some((m) => m.key === key))
}

function mapGroup(state: SessionGroups, id: string, fn: (g: SessionGroup) => SessionGroup): SessionGroups {
  return { ...state, groups: state.groups.map((g) => (g.id === id ? fn(g) : g)) }
}

/** Takes a member out of wherever it is (a group or the top level). */
function detach(state: SessionGroups, key: string): SessionGroups {
  return {
    groups: state.groups.map((g) => (g.members.some((m) => m.key === key) ? { ...g, members: g.members.filter((m) => m.key !== key) } : g)),
    top: state.top.filter((s) => !(s.kind === 'session' && s.key === key))
  }
}

// Groups

/** Adds a group at `at` in the top level (default: the end), holding `member` when given. */
export function createGroup(state: SessionGroups, id: string, name: string, member?: GroupMember, at?: number): SessionGroups {
  if (state.groups.some((g) => g.id === id)) return state
  const base = member ? detach(state, member.key) : state
  const top = [...base.top]
  top.splice(Math.min(at ?? top.length, top.length), 0, groupSlot(id))
  return { groups: [...base.groups, { id, name, collapsed: false, members: member ? [member] : [] }], top }
}

export function renameGroup(state: SessionGroups, id: string, name: string): SessionGroups {
  return mapGroup(state, id, (g) => ({ ...g, name }))
}

export function setGroupCollapsed(state: SessionGroups, id: string, collapsed: boolean): SessionGroups {
  return mapGroup(state, id, (g) => (g.collapsed === collapsed ? g : { ...g, collapsed }))
}

/**
 * Removes a group. Its open sessions (`liveKeys`) take its place at the top level; its closed
 * members go with it, since the user removed the group they were listed in.
 */
export function deleteGroup(state: SessionGroups, id: string, liveKeys: ReadonlySet<string>): SessionGroups {
  const group = state.groups.find((g) => g.id === id)
  if (!group) return state
  const index = state.top.findIndex((s) => same(s, groupSlot(id)))
  const back = group.members.filter((m) => liveKeys.has(m.key)).map((m) => sessionSlot(m.key))
  const top = [...state.top]
  if (index >= 0) top.splice(index, 1, ...back)
  else top.push(...back)
  return { groups: state.groups.filter((g) => g.id !== id), top }
}

// Moving sessions

/** Appends a session to a group (a drop on the group's row, or "Move to group"). */
export function moveToGroup(state: SessionGroups, member: GroupMember, groupId: string): SessionGroups {
  const target = state.groups.find((g) => g.id === groupId)
  if (!target) return state
  if (target.members.some((m) => m.key === member.key)) return state
  const detached = detach(state, member.key)
  return mapGroup(detached, groupId, (g) => ({ ...g, members: [...g.members, member] }))
}

/**
 * Puts a session in `targetKey`'s place, in the target's container (a group or the top level).
 * Within one container the rows between them shift by one, as a drag does: a session moved down
 * lands below the target, one moved up or in from elsewhere lands above it.
 */
export function moveOnto(state: SessionGroups, member: GroupMember, targetKey: string): SessionGroups {
  if (member.key === targetKey) return state
  const targetGroup = groupOf(state, targetKey)
  if (targetGroup) {
    const index = targetGroup.members.findIndex((m) => m.key === targetKey)
    const detached = detach(state, member.key)
    return mapGroup(detached, targetGroup.id, (g) => {
      const members = [...g.members]
      members.splice(Math.min(index, members.length), 0, member)
      return { ...g, members }
    })
  }
  const index = state.top.findIndex((s) => same(s, sessionSlot(targetKey)))
  if (index < 0) return state
  const detached = detach(state, member.key)
  const top = [...detached.top]
  top.splice(Math.min(index, top.length), 0, sessionSlot(member.key))
  return { ...detached, top }
}

/**
 * Takes a session out of its group to the top level: right below its group, or at `index` (0 for a
 * drop on the Sessions header, which also moves an ungrouped session there).
 */
export function ungroup(state: SessionGroups, key: string, index?: number): SessionGroups {
  const group = groupOf(state, key)
  if (!group && index === undefined) return state
  const detached = detach(state, key)
  const below = group ? detached.top.findIndex((s) => same(s, groupSlot(group.id))) + 1 : -1
  const top = [...detached.top]
  top.splice(Math.min(index ?? (below > 0 ? below : top.length), top.length), 0, sessionSlot(key))
  return { ...detached, top }
}

function swap<T>(list: readonly T[], index: number, step: number): T[] | null {
  const other = index + step
  if (index < 0 || other < 0 || other >= list.length) return null
  const copy = [...list]
  ;[copy[index], copy[other]] = [copy[other]!, copy[index]!]
  return copy
}

/** Moves a session one place up (`-1`) or down (`1`) within its container. */
export function moveBy(state: SessionGroups, key: string, step: -1 | 1): SessionGroups {
  const group = groupOf(state, key)
  if (group) {
    const members = swap(group.members, group.members.findIndex((m) => m.key === key), step)
    return members ? mapGroup(state, group.id, (g) => ({ ...g, members })) : state
  }
  const top = swap(state.top, state.top.findIndex((s) => same(s, sessionSlot(key))), step)
  return top ? { ...state, top } : state
}

/** Moves a group one place up or down among the top-level rows. */
export function moveGroupBy(state: SessionGroups, id: string, step: -1 | 1): SessionGroups {
  const top = swap(state.top, state.top.findIndex((s) => same(s, groupSlot(id))), step)
  return top ? { ...state, top } : state
}

/** Puts a group in a top-level row's place (a drop on another group, or on an ungrouped session). */
export function moveGroupOnto(state: SessionGroups, id: string, target: TopSlot): SessionGroups {
  if (same(target, groupSlot(id))) return state
  const from = state.top.findIndex((s) => same(s, groupSlot(id)))
  const to = state.top.findIndex((s) => same(s, target))
  if (from < 0 || to < 0) return state
  const top = [...state.top]
  top.splice(to, 0, top.splice(from, 1)[0]!)
  return { ...state, top }
}

/** Drops a member from its group, whether the session is open or not. */
export function removeMember(state: SessionGroups, key: string): SessionGroups {
  return groupOf(state, key) ? detach(state, key) : state
}

/**
 * Hands the group and position of one session to the session that replaces it (an automation
 * that restarts a run, a session moved to another account). If the new identity already has a
 * place, the old one is just dropped, so a session is never listed twice.
 */
export function replaceSessionIdentity(state: SessionGroups, oldKey: string, newKey: string, meta?: Partial<Omit<GroupMember, 'key'>>): SessionGroups {
  if (oldKey === newKey) return state
  if (!groupOf(state, oldKey) && !state.top.some((s) => same(s, sessionSlot(oldKey)))) return state
  const alreadyThere = groupOf(state, newKey) !== undefined || state.top.some((s) => same(s, sessionSlot(newKey)))
  if (alreadyThere) return detach(state, oldKey)
  return {
    groups: state.groups.map((g) =>
      g.members.some((m) => m.key === oldKey) ? { ...g, members: g.members.map((m) => (m.key === oldKey ? { ...m, ...meta, key: newKey } : m)) } : g
    ),
    top: state.top.map((s) => (s.kind === 'session' && s.key === oldKey ? sessionSlot(newKey) : s))
  }
}

// Keeping the layout in line with the open sessions

/**
 * The top level brought in line with the open sessions (`liveKeys`, in the order they should
 * appear when new): ungrouped sessions that are no longer open are dropped, sessions that live
 * in a group are not listed twice, unplaced open sessions go at the end, and a group missing
 * from the top level is added back. Returns the same object when nothing changes.
 */
export function reconcileTop(state: SessionGroups, liveKeys: readonly string[]): SessionGroups {
  const live = new Set(liveKeys)
  const grouped = new Set(state.groups.flatMap((g) => g.members.map((m) => m.key)))
  const groupIds = new Set(state.groups.map((g) => g.id))
  const seen: TopSlot[] = []
  for (const slot of state.top) {
    if (slot.kind === 'group' ? !groupIds.has(slot.id) : !live.has(slot.key) || grouped.has(slot.key)) continue
    if (!seen.some((s) => same(s, slot))) seen.push(slot)
  }
  for (const g of state.groups) if (!seen.some((s) => same(s, groupSlot(g.id)))) seen.push(groupSlot(g.id))
  for (const key of liveKeys) if (!grouped.has(key) && !seen.some((s) => same(s, sessionSlot(key)))) seen.push(sessionSlot(key))
  const unchanged = seen.length === state.top.length && seen.every((s, i) => same(s, state.top[i]!))
  return unchanged ? state : { ...state, top: seen }
}

/** Updates what members remember (title, agent, folder) from their open sessions. Same object when nothing differs. */
export function refreshMembers(state: SessionGroups, live: readonly GroupMember[]): SessionGroups {
  const byKey = new Map(live.map((m) => [m.key, m]))
  let changed = false
  const groups = state.groups.map((g) => {
    let touched = false
    const members = g.members.map((m) => {
      const l = byKey.get(m.key)
      if (!l || (l.title === m.title && l.agentKey === m.agentKey && l.cwd === m.cwd)) return m
      touched = true
      return l
    })
    if (!touched) return g
    changed = true
    return { ...g, members }
  })
  return changed ? { ...state, groups } : state
}

// What the sidebar draws

export type SidebarRow<T extends { key: string }> =
  | { type: 'session'; key: string; session: T }
  | { type: 'group'; group: SessionGroup; members: { member: GroupMember; session?: T }[] }

/**
 * The sidebar's rows. `sessions` holds one entry per identity (callers keep the open one when a
 * session was reopened); a member without an entry is closed and is listed anyway.
 */
export function sidebarRows<T extends { key: string }>(state: SessionGroups, sessions: readonly T[]): SidebarRow<T>[] {
  const byKey = new Map(sessions.map((s) => [s.key, s]))
  const rows: SidebarRow<T>[] = []
  for (const slot of reconcileTop(state, sessions.map((s) => s.key)).top) {
    if (slot.kind === 'session') {
      const session = byKey.get(slot.key)
      if (session) rows.push({ type: 'session', key: slot.key, session })
      continue
    }
    const group = state.groups.find((g) => g.id === slot.id)
    if (group) rows.push({ type: 'group', group, members: group.members.map((member) => ({ member, session: byKey.get(member.key) })) })
  }
  return rows
}
