/**
 * The Plan work bridge: milestones and the inbox of a profile. Every argument is checked here; the
 * renderer is not trusted with shapes.
 */
import type { BrowserWindow } from 'electron'
import { INBOX_ACTIONS, INBOX_KINDS, INBOX_LIMITS, isDay, parseInboxProposal, parseInboxProposals, parseMilestone, parsePlanLinks, parseTicketKey, PIECE_LIMITS, type InboxAction, type InboxBulkPatch, type InboxKind, type InboxSource, type MetricAlert } from '@workhub/core'
import { parsePlanItemTarget, planItemHash, planItemKey } from '../shared/plan-item-window'
import type { InboxAddResult, InboxEdit } from '../shared/planner-api'
import type { IpcRegistrar } from './ipc-guard'
import { parseTicketLink, resolveControlProfile, type ControlProfileDeps } from './plan-control'
import type { PlannerService } from './planner-service'

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200
const BAD = { ok: false as const, error: 'bad request' }

/** A bulk patch: each field a short string, null to clear, or absent; a due date must be a day. */
export function parseBulkPatch(value: unknown): InboxBulkPatch | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const out: InboxBulkPatch = {}
  for (const key of ['area', 'criticality', 'due'] as const) {
    const x = v[key]
    if (x === undefined) continue
    if (x === null || x === '') out[key] = null
    else if (typeof x === 'string' && x.length <= 200 && (key !== 'due' || isDay(x))) out[key] = x.trim()
    else return null
  }
  return out
}

/** A single item's edit, checked field by field. */
export function parseInboxEdit(value: unknown): InboxEdit | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const out: InboxEdit = {}
  if (v['title'] !== undefined) {
    if (typeof v['title'] !== 'string') return null
    const title = v['title'].replace(/\s+/g, ' ').trim()
    if (!title || title.length > INBOX_LIMITS.title) return null
    out.title = title
  }
  if (v['detail'] !== undefined) {
    if (typeof v['detail'] !== 'string' || v['detail'].length > INBOX_LIMITS.detail) return null
    out.detail = v['detail'].trim()
  }
  if (v['kind'] !== undefined) {
    if (!(INBOX_KINDS as readonly unknown[]).includes(v['kind'])) return null
    out.kind = v['kind'] as InboxKind
  }
  if (v['people'] !== undefined) {
    if (!Array.isArray(v['people']) || v['people'].length > INBOX_LIMITS.people || !v['people'].every(isId)) return null
    out.people = v['people'] as string[]
  }
  const fields = parseBulkPatch({ due: v['due'], area: v['area'], criticality: v['criticality'] })
  if (!fields) return null
  Object.assign(out, fields)
  if (v['links'] !== undefined) {
    const links = parsePlanLinks(v['links'])
    if (typeof links === 'string') return null
    out.links = links
  }
  return out
}

export interface PlannerIpcExtras {
  /** A metric alert of a profile by key ("Send to inbox" on Health → Alerts). */
  alert?: (profileId: string, key: string) => Promise<MetricAlert | undefined>
  /** Tells the alert engine it was sent (a new alert becomes tracked). */
  alertSent?: (profileId: string, key: string) => Promise<unknown>
  /** Creates the window of an inbox item or milestone for its hash (`planItemHash`). */
  createWindow?: (hash: string, title: string) => BrowserWindow
}

export function registerPlannerIpc(ipc: IpcRegistrar, service: PlannerService, extras: PlannerIpcExtras = {}): void {
  ipc.handle('planner:fromAlert', async (_e, profileId: unknown, key: unknown): Promise<InboxAddResult> => {
    if (!isId(profileId) || typeof key !== 'string' || key.length > 500) return BAD
    const alert = await extras.alert?.(profileId, key)
    if (!alert) return { ok: false, error: 'The alert no longer exists' }
    const r = await service.fromAlert(profileId, alert)
    if (r.ok) await extras.alertSent?.(profileId, key)
    return r
  })
  ipc.handle('planner:get', (_e, profileId: unknown) => {
    if (!isId(profileId)) throw new Error('bad request')
    return service.view(profileId)
  })
  ipc.handle('planner:saveMilestone', (_e, profileId: unknown, milestone: unknown) => {
    const m = parseMilestone(milestone)
    return isId(profileId) && m ? service.saveMilestone(profileId, m) : { ok: false, error: 'The milestone is not valid' }
  })
  ipc.handle('planner:resolveProposal', (_e, profileId: unknown, id: unknown, accept: unknown) => (isId(profileId) && isId(id) && typeof accept === 'boolean' ? service.resolveProposal(profileId, id, accept) : BAD))
  ipc.handle('planner:deleteMilestone', (_e, profileId: unknown, id: unknown) => (isId(profileId) && isId(id) ? service.deleteMilestone(profileId, id) : BAD))
  ipc.handle('planner:refreshMilestones', (_e, profileId: unknown) => {
    if (!isId(profileId)) throw new Error('bad request')
    return service.refreshMilestones(profileId)
  })
  ipc.handle('planner:lookupTicket', (_e, profileId: unknown, key: unknown, connectionId: unknown) => {
    const k = parseTicketKey(key)
    if (!isId(profileId) || !k || (connectionId !== undefined && connectionId !== null && !(typeof connectionId === 'string' && connectionId.length <= PIECE_LIMITS.connectionId))) return BAD
    return service.lookupTicket(profileId, k, typeof connectionId === 'string' && connectionId ? connectionId : undefined)
  })
  ipc.handle('planner:linkTicket', (_e, profileId: unknown, id: unknown, ticket: unknown) => {
    const parsed = parseTicketLink(ticket)
    return isId(profileId) && isId(id) && parsed !== undefined ? service.linkItemTicket(profileId, id, parsed) : BAD
  })
  ipc.handle('planner:addItem', (_e, profileId: unknown, proposal: unknown, force: unknown) => {
    const parsed = parseInboxProposal(proposal)
    if (!isId(profileId)) return BAD
    if (typeof parsed === 'string') return { ok: false, error: parsed }
    return service.addItem(profileId, parsed, force === true)
  })
  ipc.handle('planner:editItem', (_e, profileId: unknown, id: unknown, edit: unknown) => {
    const parsed = parseInboxEdit(edit)
    return isId(profileId) && isId(id) && parsed ? service.editItem(profileId, id, parsed) : BAD
  })
  ipc.handle('planner:act', (_e, profileId: unknown, id: unknown, action: unknown) =>
    isId(profileId) && isId(id) && (INBOX_ACTIONS as readonly unknown[]).includes(action) ? service.act(profileId, id, action as InboxAction) : BAD
  )
  ipc.handle('planner:bulkEdit', (_e, profileId: unknown, ids: unknown, patch: unknown) => {
    const parsed = parseBulkPatch(patch)
    if (!isId(profileId) || !Array.isArray(ids) || ids.length > INBOX_LIMITS.items || !ids.every(isId) || !parsed) return BAD
    return service.bulkEdit(profileId, ids, parsed)
  })
  // One window per item: opening it again focuses the one already open (and asking to edit it opens its form there).
  const windows = new Map<string, BrowserWindow>()
  ipc.on('planner:openWindow', (_e, target: unknown) => {
    const parsed = parsePlanItemTarget(target)
    if (!parsed || !extras.createWindow) return
    const key = planItemKey(parsed)
    const open = windows.get(key)
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore()
      open.focus()
      if ('edit' in parsed && parsed.edit) open.webContents.send('planner:edit')
      return
    }
    const w = extras.createWindow(planItemHash(parsed), 'Plan')
    windows.set(key, w)
    w.on('closed', () => windows.delete(key))
  })
}

export interface ControlInboxDeps extends ControlProfileDeps {
  service: Pick<PlannerService, 'propose'>
}

/**
 * `POST /v1/inbox`: the profile is the one of `session` (an agent passes `$WORKHUB_SESSION`), else
 * `profile`, else the active one. Items are added as pending; repeats of open items are skipped
 * and named in `duplicates` (the ids of the open items they repeat); `added` has the new ids.
 */
export async function addControlInboxItems(deps: ControlInboxDeps, body: unknown): Promise<{ ok: true; added: string[]; duplicates: string[] } | { ok: false; status: number; error: string }> {
  const parsed = parseInboxProposals(body)
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const who = await resolveControlProfile(deps, { session: b['session'], profile: b['profile'], cwd: b['cwd'] })
  if (!who.ok) return who
  const { profileId, session } = who
  const source: InboxSource = { type: b['sourceType'] === 'meeting' ? 'meeting' : 'agent', ...(session ? { ref: session } : {}), ...(parsed.label ? { label: parsed.label } : {}) }
  const r = await deps.service.propose(profileId, parsed.items, source)
  return 'error' in r ? { ok: false, status: 409, error: r.error } : { ok: true, ...r }
}
