import { describe, expect, it } from 'vitest'
import { isNewMilestone, parsePlanItemHash, parsePlanItemTarget, planItemHash, planItemKey } from '../src/shared/plan-item-window'

describe('Plan item window route', () => {
  it('round-trips an inbox item and a milestone through the hash', () => {
    const inbox = { profileId: 'work space', kind: 'inbox' as const, id: '3f2c-41' }
    expect(planItemHash(inbox)).toBe('#plan-item?profile=work+space&kind=inbox&id=3f2c-41')
    expect(parsePlanItemHash(planItemHash(inbox))).toEqual(inbox)
    const milestone = { profileId: 'work', kind: 'milestone' as const, id: 'beta-launch' }
    expect(parsePlanItemHash(planItemHash(milestone))).toEqual(milestone)
    expect(planItemKey(inbox)).not.toBe(planItemKey({ ...inbox, kind: 'milestone' }))
  })

  it('carries the edit form and a new milestone', () => {
    const edit = { profileId: 'work', kind: 'milestone' as const, id: 'beta-launch', edit: true }
    expect(planItemHash(edit)).toBe('#plan-item?profile=work&kind=milestone&id=beta-launch&edit=1')
    expect(parsePlanItemHash(planItemHash(edit))).toEqual(edit)
    // Viewing and editing an item share its window.
    expect(planItemKey(edit)).toBe(planItemKey({ profileId: 'work', kind: 'milestone', id: 'beta-launch' }))
    expect(parsePlanItemHash('#plan-item?profile=work&kind=inbox&id=a&edit=0')).toEqual({ profileId: 'work', kind: 'inbox', id: 'a' })

    const fresh = { profileId: 'work', kind: 'milestone' as const, new: true as const }
    expect(planItemHash(fresh)).toBe('#plan-item?profile=work&kind=milestone&new=1')
    const parsed = parsePlanItemHash(planItemHash(fresh))
    expect(parsed).toEqual(fresh)
    expect(parsed && isNewMilestone(parsed)).toBe(true)
    // One "new milestone" window per profile, apart from any milestone's window (ids cannot hold `+`).
    expect(planItemKey(fresh)).not.toBe(planItemKey({ profileId: 'work', kind: 'milestone', id: 'new' }))
    expect(planItemKey(fresh)).not.toBe(planItemKey({ ...fresh, profileId: 'home' }))
  })

  it('refuses a new item that is not a milestone, or that names an id', () => {
    expect(parsePlanItemHash('#plan-item?profile=work&kind=inbox&new=1')).toBeNull()
    expect(parsePlanItemHash('#plan-item?profile=work&kind=milestone&new=1&id=a')).toBeNull()
    expect(parsePlanItemHash('#plan-item?profile=work&kind=milestone&new=yes')).toBeNull()
    expect(parsePlanItemTarget({ profileId: 'work', kind: 'inbox', new: true })).toBeNull()
    expect(parsePlanItemTarget({ profileId: 'work', kind: 'milestone', new: true, id: 'a' })).toBeNull()
    expect(parsePlanItemTarget({ profileId: 'work', kind: 'milestone', id: 'a', edit: 'yes' })).toEqual({ profileId: 'work', kind: 'milestone', id: 'a' })
  })

  it('ignores other hashes and malformed targets', () => {
    expect(parsePlanItemHash('')).toBeNull()
    expect(parsePlanItemHash('#flow-map?profile=work&env=e&id=m')).toBeNull()
    expect(parsePlanItemHash('#plan-item?profile=work&kind=epic&id=a')).toBeNull()
    expect(parsePlanItemHash('#plan-item?profile=work&kind=inbox')).toBeNull()
    expect(parsePlanItemHash('#plan-item?kind=inbox&id=a')).toBeNull()
    expect(parsePlanItemHash('#plan-item?profile=work&kind=inbox&id=a%20b')).toBeNull()
    expect(parsePlanItemTarget({ profileId: 'work', kind: 'milestone', id: 'x'.repeat(201) })).toBeNull()
    expect(parsePlanItemTarget('work')).toBeNull()
    expect(parsePlanItemTarget({ profileId: 'work', kind: 'inbox', id: 'a' })).toEqual({ profileId: 'work', kind: 'inbox', id: 'a' })
  })
})
