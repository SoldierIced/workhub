/**
 * Sidebar session groups ("folders" of sessions). Pure functions over a plain value that is stored
 * in the config, so the UI, the main process and later automations share one set of rules.
 *
 * A member is keyed by the session's stable identity (the agent's own session id: it survives a
 * resume and the hand-over between app and terminal mode), never by a UI or console id. Membership
 * is not tied to a session being open: a closed member stays in its group until the user removes
 * it, and a session that is reopened appears at its stored place.
 */
import { promptTitle } from './prompt-text'

/** What a group remembers about a member, to list and reopen it while it is closed. */
export interface GroupMember {
  /** The session's stable identity; see `sessionIdentity`. */
  key: string
  /** What the sidebar shows while the session is closed. */
  title: string
  /** `effectiveAgentKey(agentId, accountId)` of the agent that ran it. */
  agentKey: string
  cwd: string
  /** The profile it ran in: its colour marks the row while the session is closed too. */
  profileId?: string
  /**
   * Whether `title` is the session's own name (the user's rename, the agent's title or the first
   * prompt) rather than its folder: a folder title is replaced as soon as a real name is known.
   */
  titled?: boolean
  /** The agent and account that ran it, so a closed row shows its agent icon and account. */
  agentId?: string
  agentName?: string
  accountId?: string
  accountName?: string
  /** The session history was searched once for this member (found or not): it is not searched again. */
  lookedUp?: boolean
}

export interface SessionGroup {
  id: string
  name: string
  collapsed: boolean
  /** The group this one sits in (a sub-group); unset at the top level. */
  parentId?: string
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

// Nesting: a group may sit in another one (`parentId`). Only top-level groups have a slot in
// `top`; sub-groups are listed in their parent, in the order of `groups`. A parent that no longer
// exists, or a loop of parents (a hand-edited config), puts the group back at the top level.

/** The id of the group a group sits in, when that group exists and is not inside the group itself. */
export function parentIdOf(state: SessionGroups, id: string): string | undefined {
  const byId = new Map(state.groups.map((g) => [g.id, g]))
  const parent = byId.get(id)?.parentId
  if (!parent || !byId.has(parent)) return undefined
  const seen = new Set([id])
  for (let at: string | undefined = parent; at; at = byId.get(at)?.parentId) {
    if (seen.has(at)) return undefined
    if (!byId.has(at)) break
    seen.add(at)
  }
  return parent
}

/** The groups listed right inside `parentId` (`undefined`: the top level), in their stored order. */
export function childGroups(state: SessionGroups, parentId: string | undefined): SessionGroup[] {
  return state.groups.filter((g) => parentIdOf(state, g.id) === parentId)
}

/** Every group inside a group, at any depth. */
export function descendantIds(state: SessionGroups, id: string): Set<string> {
  const out = new Set<string>()
  const walk = (at: string) => {
    for (const c of childGroups(state, at)) {
      if (out.has(c.id) || c.id === id) continue
      out.add(c.id)
      walk(c.id)
    }
  }
  walk(id)
  return out
}

/** The names from the top-level group down to this one ("Work", "Work / Backend"). */
export function groupPath(state: SessionGroups, id: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (let at: string | undefined = id; at && !seen.has(at); at = parentIdOf(state, at)) {
    seen.add(at)
    const g = state.groups.find((x) => x.id === at)
    if (!g) break
    names.unshift(g.name)
  }
  return names
}

/** Whether a group can go inside `parentId`: never into itself or one of its own sub-groups. */
export function canNestGroup(state: SessionGroups, id: string, parentId: string): boolean {
  if (id === parentId || !state.groups.some((g) => g.id === id) || !state.groups.some((g) => g.id === parentId)) return false
  return !descendantIds(state, id).has(parentId)
}

/** The top-level group a group is in (itself when it is one). */
function rootOf(state: SessionGroups, id: string): string {
  const seen = new Set<string>()
  let at = id
  for (let p = parentIdOf(state, at); p && !seen.has(p); p = parentIdOf(state, at)) {
    seen.add(p)
    at = p
  }
  return at
}

/** A group with its parent set (or taken away), moved to the end of the stored order: the last of its new siblings. */
function withParent(state: SessionGroups, id: string, parentId: string | undefined): SessionGroup[] {
  const group = { ...state.groups.find((g) => g.id === id)! }
  delete group.parentId
  return [...state.groups.filter((g) => g.id !== id), parentId ? { ...group, parentId } : group]
}

/**
 * Moves a group into another one (`parentId`), last among its sub-groups, or out to the top level
 * (`null`), right below the top-level group it was in. Unchanged when it would go into itself or
 * one of its own sub-groups.
 */
export function nestGroup(state: SessionGroups, id: string, parentId: string | null): SessionGroups {
  if (!state.groups.some((g) => g.id === id)) return state
  const current = parentIdOf(state, id)
  if (parentId === null) {
    if (current === undefined) return state
    const root = rootOf(state, id)
    const top = state.top.filter((s) => !same(s, groupSlot(id)))
    const below = top.findIndex((s) => same(s, groupSlot(root)))
    top.splice(below < 0 ? top.length : below + 1, 0, groupSlot(id))
    return { groups: withParent(state, id, undefined), top }
  }
  if (current === parentId || !canNestGroup(state, id, parentId)) return state
  return { groups: withParent(state, id, parentId), top: state.top.filter((s) => !same(s, groupSlot(id))) }
}

/**
 * Adds a group at `at` in the top level (default: the end), holding `member` when given; with
 * `parentId` (a group that exists), as the last sub-group of that group instead.
 */
export function createGroup(state: SessionGroups, id: string, name: string, member?: GroupMember, at?: number, parentId?: string): SessionGroups {
  if (state.groups.some((g) => g.id === id)) return state
  const base = member ? detach(state, member.key) : state
  const nested = parentId !== undefined && base.groups.some((g) => g.id === parentId)
  const top = [...base.top]
  if (!nested) top.splice(Math.min(at ?? top.length, top.length), 0, groupSlot(id))
  const group: SessionGroup = { id, name, collapsed: false, members: member ? [member] : [], ...(nested ? { parentId } : {}) }
  return { groups: [...base.groups, group], top }
}

export function renameGroup(state: SessionGroups, id: string, name: string): SessionGroups {
  return mapGroup(state, id, (g) => ({ ...g, name }))
}

export function setGroupCollapsed(state: SessionGroups, id: string, collapsed: boolean): SessionGroups {
  return mapGroup(state, id, (g) => (g.collapsed === collapsed ? g : { ...g, collapsed }))
}

/**
 * Removes a group. Its sub-groups and open sessions (`liveKeys`) take its place: in its parent
 * group for a sub-group, else at the top level. Its closed members go with it, since the user
 * removed the group they were listed in.
 */
export function deleteGroup(state: SessionGroups, id: string, liveKeys: ReadonlySet<string>): SessionGroups {
  const group = state.groups.find((g) => g.id === id)
  if (!group) return state
  const parent = parentIdOf(state, id)
  const children = new Set(childGroups(state, id).map((g) => g.id))
  const open = group.members.filter((m) => liveKeys.has(m.key))
  const groups = state.groups
    .filter((g) => g.id !== id)
    .map((g) => {
      if (children.has(g.id)) {
        const moved = { ...g }
        if (parent) moved.parentId = parent
        else delete moved.parentId
        return moved
      }
      return parent && g.id === parent ? { ...g, members: [...g.members, ...open] } : g
    })
  if (parent) return { groups, top: state.top.filter((s) => !same(s, groupSlot(id))) }
  const index = state.top.findIndex((s) => same(s, groupSlot(id)))
  const back = [...[...children].map(groupSlot), ...open.map((m) => sessionSlot(m.key))]
  const top = [...state.top]
  if (index >= 0) top.splice(index, 1, ...back)
  else top.push(...back)
  return { groups, top }
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

/** Where a new session goes in the sidebar (the New session dialog's Group): an existing group, or a new one by name. */
export type GroupChoice = { groupId: string } | { name: string }

/** The longest group name the New session dialog saves. */
export const GROUP_NAME_MAX = 120

/**
 * The group a choice names, checked: an id must be a non-empty string, a name is trimmed and cut
 * to `GROUP_NAME_MAX`. Anything else (no group, an empty name) is `undefined`: the session stays ungrouped.
 */
export function parseGroupChoice(raw: unknown): GroupChoice | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as { groupId?: unknown; name?: unknown }
  if (typeof v.groupId === 'string' && v.groupId) return { groupId: v.groupId.slice(0, 200) }
  if (typeof v.name === 'string' && v.name.trim()) return { name: v.name.trim().slice(0, GROUP_NAME_MAX) }
  return undefined
}

/**
 * Puts a new session in the group chosen for it: the group with that id (unchanged when it no
 * longer exists), or the group with that name (case and outer spaces ignored), else a new group
 * `newId` with that name at the end of the list.
 */
export function placeInGroup(state: SessionGroups, member: GroupMember, choice: GroupChoice, newId: string): SessionGroups {
  if ('groupId' in choice) return moveToGroup(state, member, choice.groupId)
  const name = choice.name.trim()
  if (!name) return state
  const wanted = name.toLowerCase()
  const existing = state.groups.find((g) => g.name.trim().toLowerCase() === wanted)
  return existing ? moveToGroup(state, member, existing.id) : createGroup(state, newId, name, member)
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
  const parent = parentIdOf(state, id)
  if (parent !== undefined) {
    // A sub-group swaps places with its neighbouring sub-group, in the stored order.
    const siblings = childGroups(state, parent)
    const other = siblings[siblings.findIndex((g) => g.id === id) + step]
    if (!other) return state
    const a = state.groups.findIndex((g) => g.id === id)
    const b = state.groups.findIndex((g) => g.id === other.id)
    const groups = [...state.groups]
    ;[groups[a], groups[b]] = [groups[b]!, groups[a]!]
    return { ...state, groups }
  }
  const top = swap(state.top, state.top.findIndex((s) => same(s, groupSlot(id))), step)
  return top ? { ...state, top } : state
}

/**
 * Puts a group in a row's place (a drop on another group, or on an ungrouped session), in that
 * row's container: a top-level row, or a sub-group's place in its parent. Unchanged when the
 * target is the group itself or one of its own sub-groups.
 */
export function moveGroupOnto(state: SessionGroups, id: string, target: TopSlot): SessionGroups {
  if (same(target, groupSlot(id)) || !state.groups.some((g) => g.id === id)) return state
  const targetParent = target.kind === 'group' ? parentIdOf(state, target.id) : undefined
  if (target.kind === 'group' && (!state.groups.some((g) => g.id === target.id) || descendantIds(state, id).has(target.id))) return state
  if (targetParent !== undefined) {
    // Into the target's parent, just before the target.
    if (!canNestGroup(state, id, targetParent)) return state
    const moved = { ...state.groups.find((g) => g.id === id)!, parentId: targetParent }
    const groups = state.groups.filter((g) => g.id !== id)
    const targetId = target.kind === 'group' ? target.id : ''
    groups.splice(groups.findIndex((g) => g.id === targetId), 0, moved)
    return { groups, top: state.top.filter((s) => !same(s, groupSlot(id))) }
  }
  // To the top level, in the target's place.
  const base: SessionGroups = parentIdOf(state, id) !== undefined ? { groups: withParent(state, id, undefined), top: state.top } : state
  const from = base.top.findIndex((s) => same(s, groupSlot(id)))
  const top = [...base.top]
  if (from >= 0) top.splice(from, 1)
  const to = top.findIndex((s) => same(s, target))
  if (to < 0) return state
  // Within the top level a group moved down lands below the target, as a drag does.
  top.splice(from >= 0 && from <= to ? to + 1 : to, 0, groupSlot(id))
  return { ...base, top }
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
  // A replacement already in a group was put there on purpose: it keeps that place. One that only
  // sits on the top level got there by itself (an open session nobody placed yet, saved while it
  // started): the old place wins, so a replaced session never falls out of its group.
  if (groupOf(state, newKey) !== undefined) return detach(state, oldKey)
  return {
    groups: state.groups.map((g) =>
      g.members.some((m) => m.key === oldKey) ? { ...g, members: g.members.map((m) => (m.key === oldKey ? { ...m, ...meta, key: newKey } : m)) } : g
    ),
    top: state.top.filter((s) => !same(s, sessionSlot(newKey))).map((s) => (s.kind === 'session' && s.key === oldKey ? sessionSlot(newKey) : s))
  }
}

/**
 * Puts a session right after `anchorKey`, in the anchor's container (its group, or the top level
 * when the anchor is ungrouped and placed): a session handed off from another one sits next to it.
 * Unchanged when the anchor has no place or the session already sits in the anchor's group.
 */
export function placeBeside(state: SessionGroups, member: GroupMember, anchorKey: string): SessionGroups {
  if (member.key === anchorKey) return state
  const group = groupOf(state, anchorKey)
  if (group) {
    if (group.members.some((m) => m.key === member.key)) return state
    const detached = detach(state, member.key)
    return mapGroup(detached, group.id, (g) => {
      const members = [...g.members]
      members.splice(members.findIndex((m) => m.key === anchorKey) + 1, 0, member)
      return { ...g, members }
    })
  }
  if (!state.top.some((s) => same(s, sessionSlot(anchorKey)))) return state
  const detached = detach(state, member.key)
  const top = [...detached.top]
  top.splice(top.findIndex((s) => same(s, sessionSlot(anchorKey))) + 1, 0, sessionSlot(member.key))
  return { ...detached, top }
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
  // Only top-level groups have a slot; a sub-group is listed in its parent.
  const topGroups = childGroups(state, undefined)
  const groupIds = new Set(topGroups.map((g) => g.id))
  const seen: TopSlot[] = []
  for (const slot of state.top) {
    if (slot.kind === 'group' ? !groupIds.has(slot.id) : !live.has(slot.key) || grouped.has(slot.key)) continue
    if (!seen.some((s) => same(s, slot))) seen.push(slot)
  }
  for (const g of topGroups) if (!seen.some((s) => same(s, groupSlot(g.id)))) seen.push(groupSlot(g.id))
  for (const key of liveKeys) if (!grouped.has(key) && !seen.some((s) => same(s, sessionSlot(key)))) seen.push(sessionSlot(key))
  const unchanged = seen.length === state.top.length && seen.every((s, i) => same(s, state.top[i]!))
  return unchanged ? state : { ...state, top: seen }
}

// Names

/** The last segment of a path: what a session without a name of its own is called. */
export function folderLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** Where a session's name can come from, strongest first. */
export interface SessionNameSources {
  /** The name the user gave it (Rename…, kept in session-names.json). */
  name?: string
  /** The agent's own title for it (a custom title or generated summary from its transcript). */
  title?: string
  /** What the user first asked. */
  firstPrompt?: string
  /** Its folder: the name of last resort. */
  cwd: string
}

/**
 * What a session is called: the user's rename, else the agent's title, else the first line of the
 * first prompt, else its folder. `titled` tells whether it has a name of its own.
 */
export function resolveSessionName(sources: SessionNameSources): { title: string; titled: boolean } {
  const own = promptTitle(sources.name) ?? promptTitle(sources.title) ?? promptTitle(sources.firstPrompt)
  return own ? { title: own, titled: true } : { title: folderLabel(sources.cwd), titled: false }
}

const MEMBER_FIELDS = ['title', 'titled', 'agentKey', 'cwd', 'profileId', 'agentId', 'agentName', 'accountId', 'accountName', 'lookedUp'] as const

function sameMember(a: GroupMember, b: GroupMember): boolean {
  return MEMBER_FIELDS.every((f) => a[f] === b[f])
}

/**
 * What a member remembers once its open session reported `live`: everything the session knows now,
 * except that a name of its own is never replaced by its folder (a session reopened in the terminal
 * has no prompt on screen yet).
 */
export function mergeMember(stored: GroupMember, live: GroupMember): GroupMember {
  const next: GroupMember = { ...live }
  if (!live.titled && stored.titled) {
    next.title = stored.title
    next.titled = true
  }
  if (stored.lookedUp) next.lookedUp = true
  // The account's name is kept while the session still runs with the same account.
  if (next.accountName === undefined && stored.accountName !== undefined && next.accountId === stored.accountId) next.accountName = stored.accountName
  return next
}

/** Updates what members remember (title, agent, account, folder) from their open sessions. Same object when nothing differs. */
export function refreshMembers(state: SessionGroups, live: readonly GroupMember[]): SessionGroups {
  const byKey = new Map(live.map((m) => [m.key, m]))
  let changed = false
  const groups = state.groups.map((g) => {
    let touched = false
    const members = g.members.map((m) => {
      const l = byKey.get(m.key)
      if (!l) return m
      const next = mergeMember(m, l)
      if (sameMember(next, m)) return m
      touched = true
      return next
    })
    if (!touched) return g
    changed = true
    return { ...g, members }
  })
  return changed ? { ...state, groups } : state
}

/** The agent id of a member: stored, else read from its `agent:account` key. */
export function memberAgentId(m: Pick<GroupMember, 'agentKey' | 'agentId'>): string {
  return m.agentId ?? m.agentKey.split(':')[0]!
}

/**
 * Whether a member lacks its name or its agent and account (one saved before Workhub kept them, or
 * one closed before anything was asked) and the history was not searched for it yet.
 */
export function needsHistoryLookup(m: GroupMember): boolean {
  return !m.lookedUp && (!m.titled || !m.agentId)
}

/** A past session as the history lists it: enough to name a member and tell its account. */
export interface PastSessionInfo {
  agentId: string
  accountId: string | null
  accountName?: string
  agentName?: string
  agentSessionId: string
  title: string
  firstPrompt?: string
  lastModified: number
}

/**
 * Fills in what members in `searched` lack (name, agent, account) from the session history, found
 * by their stable identity (the agent's session id), and marks them searched so the history is read
 * for them once. A name of their own and a known account are never overwritten. Same object when
 * nothing changes.
 */
export function applyHistory(state: SessionGroups, entries: readonly PastSessionInfo[], searched: ReadonlySet<string>): SessionGroups {
  let changed = false
  const groups = state.groups.map((g) => {
    let touched = false
    const members = g.members.map((m) => {
      if (!searched.has(m.key) || !needsHistoryLookup(m)) return m
      const agentId = memberAgentId(m)
      const hit = entries
        .filter((e) => e.agentSessionId === m.key && e.agentId === agentId)
        .reduce<PastSessionInfo | undefined>((best, e) => (!best || e.lastModified > best.lastModified ? e : best), undefined)
      const next: GroupMember = { ...m, lookedUp: true }
      if (hit) {
        if (!m.titled) {
          const named = resolveSessionName({ title: hit.title, firstPrompt: hit.firstPrompt, cwd: m.cwd })
          next.title = named.title
          next.titled = named.titled
        }
        next.agentId = agentId
        if (hit.agentName && !m.agentName) next.agentName = hit.agentName
        if (hit.accountId && !m.accountId) {
          next.accountId = hit.accountId
          if (hit.accountName) next.accountName = hit.accountName
        }
      }
      touched = true
      return next
    })
    if (!touched) return g
    changed = true
    return { ...g, members }
  })
  return changed ? { ...state, groups } : state
}

// What the sidebar draws

/** A group as the sidebar draws it: its sub-groups (listed first), then its sessions. */
export interface GroupRow<T extends { key: string }> {
  type: 'group'
  group: SessionGroup
  members: { member: GroupMember; session?: T }[]
  children: GroupRow<T>[]
  /** How deep it sits: 0 at the top level. */
  depth: number
}

export type SidebarRow<T extends { key: string }> = { type: 'session'; key: string; session: T } | GroupRow<T>

/** A group row's members and those of every sub-group in it: what its header counts. */
export function subtreeMembers<T extends { key: string }>(row: GroupRow<T>): { member: GroupMember; session?: T }[] {
  return [...row.members, ...row.children.flatMap(subtreeMembers)]
}

/**
 * The sidebar's rows. `sessions` holds one entry per identity (callers keep the open one when a
 * session was reopened); a member without an entry is closed and is listed anyway.
 */
export function sidebarRows<T extends { key: string }>(state: SessionGroups, sessions: readonly T[]): SidebarRow<T>[] {
  const byKey = new Map(sessions.map((s) => [s.key, s]))
  const seen = new Set<string>()
  const groupRow = (group: SessionGroup, depth: number): GroupRow<T> => {
    seen.add(group.id)
    const children = childGroups(state, group.id)
      .filter((c) => !seen.has(c.id))
      .map((c) => groupRow(c, depth + 1))
    return { type: 'group', group, members: group.members.map((member) => ({ member, session: byKey.get(member.key) })), children, depth }
  }
  const rows: SidebarRow<T>[] = []
  for (const slot of reconcileTop(state, sessions.map((s) => s.key)).top) {
    if (slot.kind === 'session') {
      const session = byKey.get(slot.key)
      if (session) rows.push({ type: 'session', key: slot.key, session })
      continue
    }
    const group = state.groups.find((g) => g.id === slot.id)
    if (group) rows.push(groupRow(group, 0))
  }
  return rows
}

/** Every group in sidebar order (a parent before its sub-groups), with its depth: the New session dialog's Group list. */
export function groupTree(state: SessionGroups): { group: SessionGroup; depth: number }[] {
  const out: { group: SessionGroup; depth: number }[] = []
  const seen = new Set<string>()
  const walk = (g: SessionGroup, depth: number) => {
    if (seen.has(g.id)) return
    seen.add(g.id)
    out.push({ group: g, depth })
    for (const c of childGroups(state, g.id)) walk(c, depth + 1)
  }
  const topOrder = state.top.flatMap((s) => (s.kind === 'group' ? [s.id] : []))
  const roots = childGroups(state, undefined).sort((a, b) => rank(topOrder, a.id) - rank(topOrder, b.id))
  for (const g of roots) walk(g, 0)
  return out
}

const rank = (order: readonly string[], id: string) => {
  const i = order.indexOf(id)
  return i < 0 ? order.length : i
}
