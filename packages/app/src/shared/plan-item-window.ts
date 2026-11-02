// The hash route of a Plan item window (an inbox item or a milestone, or a new milestone), built by main and read by the renderer.

export const PLAN_ITEM_KINDS = ['inbox', 'milestone'] as const
export type PlanItemKind = (typeof PLAN_ITEM_KINDS)[number]

/** One inbox item or milestone of a profile; `edit` opens it in its edit form. */
export interface PlanItemRef {
  profileId: string
  kind: PlanItemKind
  id: string
  edit?: boolean
}

/** The form of a milestone not created yet. */
export interface NewMilestoneRef {
  profileId: string
  kind: 'milestone'
  new: true
}

/** What a Plan item window shows. */
export type PlanItemTarget = PlanItemRef | NewMilestoneRef

export const isNewMilestone = (target: PlanItemTarget): target is NewMilestoneRef => 'new' in target && target.new === true

const ID = /^[\w.:-]{1,200}$/

/** A target from untrusted input (IPC); null when it is not one. */
export function parsePlanItemTarget(value: unknown): PlanItemTarget | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const { profileId, kind, id } = v
  if (typeof profileId !== 'string' || !profileId || profileId.length > 200) return null
  if (!(PLAN_ITEM_KINDS as readonly unknown[]).includes(kind)) return null
  if (v['new'] === true) return kind === 'milestone' && id === undefined ? { profileId, kind, new: true } : null
  if (typeof id !== 'string' || !ID.test(id)) return null
  return { profileId, kind: kind as PlanItemKind, id, ...(v['edit'] === true ? { edit: true } : {}) }
}

/** `#plan-item?profile=…&kind=inbox|milestone&id=…[&edit=1]`, or `#plan-item?profile=…&kind=milestone&new=1`. */
export function planItemHash(target: PlanItemTarget): string {
  const q = new URLSearchParams({ profile: target.profileId, kind: target.kind })
  if (isNewMilestone(target)) q.set('new', '1')
  else {
    q.set('id', target.id)
    if (target.edit) q.set('edit', '1')
  }
  return `#plan-item?${q.toString()}`
}

/** The target of a `#plan-item?…` hash; null for any other hash or a malformed one. */
export function parsePlanItemHash(hash: string): PlanItemTarget | null {
  const m = /^#plan-item\?(.*)$/.exec(hash)
  if (!m) return null
  const q = new URLSearchParams(m[1])
  if (q.has('new')) return q.get('new') === '1' && !q.has('id') ? parsePlanItemTarget({ profileId: q.get('profile'), kind: q.get('kind'), new: true }) : null
  return parsePlanItemTarget({ profileId: q.get('profile'), kind: q.get('kind'), id: q.get('id'), edit: q.get('edit') === '1' })
}

/**
 * One window per item: the key the main process keeps it under. Viewing and editing an item share
 * a window (asking to edit one already open switches it to its form); a profile has one "new
 * milestone" window.
 */
export const planItemKey = (target: PlanItemTarget): string => (isNewMilestone(target) ? `${target.profileId}|milestone|+new` : `${target.profileId}|${target.kind}|${target.id}`)
