import { describe, expect, it } from 'vitest'
import { addSpend, aliasPath, attributeFolder, folderSpend, localDayKey, mergeSpend, parseSpendKey, pruneSpend, spendKey, spendWindowStart, type SpendBuckets } from '../src'

const at = (iso: string) => new Date(iso).getTime()
const day = (iso: string) => localDayKey(new Date(iso))

describe('folder spend buckets', () => {
  it('adds tokens per local day, agent and path, skipping empty amounts', () => {
    const b: SpendBuckets = {}
    addSpend(b, at('2026-10-27T10:00:00'), 'claude', '/w/api', 100)
    addSpend(b, at('2026-10-27T18:00:00'), 'claude', '/w/api', 50)
    addSpend(b, at('2026-10-27T18:00:00'), 'codex', '/w/api', 7)
    addSpend(b, at('2026-10-27T18:00:00'), 'codex', '/w/api', 0)
    addSpend(b, undefined, 'codex', '/w/api', 9)
    addSpend(b, at('2026-10-27T18:00:00'), 'kiro', undefined, 9)
    expect(b).toEqual({ [spendKey('2026-10-27', 'claude', '/w/api')]: 150, [spendKey('2026-10-27', 'codex', '/w/api')]: 7 })
    expect(parseSpendKey(spendKey('2026-10-27', 'kiro', '/a\tb'))).toEqual({ day: '2026-10-27', agent: 'kiro', path: '/a\tb' })
    expect(parseSpendKey('bad')).toBeNull()
  })

  it('prunes old days and merges sets', () => {
    const b = { [spendKey('2026-10-01', 'claude', '/a')]: 5, [spendKey('2026-10-25', 'claude', '/a')]: 3 }
    expect(pruneSpend(b, '2026-10-21')).toEqual({ [spendKey('2026-10-25', 'claude', '/a')]: 3 })
    expect(mergeSpend({ ...b }, b)[spendKey('2026-10-25', 'claude', '/a')]).toBe(6)
    expect(spendWindowStart(at('2026-10-27T12:00:00'))).toBe('2026-10-21')
  })
})

describe('attributeFolder', () => {
  const children = { '/w/wayni': ['api', 'api-gateway', 'web'] }

  it('splits a container folder by its children and keeps a repository whole', () => {
    expect(attributeFolder('/w/wayni/api/src/x', ['/w/wayni'], children)).toEqual({ name: 'api', path: '/w/wayni/api', root: false })
    expect(attributeFolder('/w/wayni', ['/w/wayni'], children)).toEqual({ name: 'wayni', path: '/w/wayni', root: true })
    expect(attributeFolder('/w/wayni/.claude', ['/w/wayni'], children)?.root).toBe(true)
    expect(attributeFolder('/w/wayni/made-up/x', ['/w/wayni'], children)?.root).toBe(true)
    expect(attributeFolder('/w/repo/packages/app', ['/w/repo'], {})).toEqual({ name: 'repo', path: '/w/repo', root: false })
  })

  it('sends a worktree to the longest child name it starts with', () => {
    expect(attributeFolder('/w/wayni/_worktrees/api-gateway-feat-x/src', ['/w/wayni'], children)?.name).toBe('api-gateway')
    expect(attributeFolder('/w/wayni/_worktrees/api-fix', ['/w/wayni'], children)?.name).toBe('api')
  })

  it('sends a removed worktree next to its repository to the longest child it extends with a dash', () => {
    const kids = { '/w/p': ['shop', 'shop-admin', 'workhub', 'workhub2'] }
    expect(attributeFolder('/w/p/shop-fix-login/src', ['/w/p'], kids)).toEqual({ name: 'shop', path: '/w/p/shop', root: false })
    expect(attributeFolder('/w/p/shop-admin-tn', ['/w/p'], kids)?.name).toBe('shop-admin')
    expect(attributeFolder('/w/p/workhub2-health', ['/w/p'], kids)?.name).toBe('workhub2')
    // A child that exists keeps its own entry; a name that only shares a prefix stays at the root.
    expect(attributeFolder('/w/p/shop-admin', ['/w/p'], kids)?.name).toBe('shop-admin')
    expect(attributeFolder('/w/p/shopping', ['/w/p'], kids)?.root).toBe(true)
  })

  it('picks the deepest profile folder and ignores paths outside every folder or sharing a prefix', () => {
    expect(attributeFolder('/w/wayni/web/a', ['/w/wayni', '/w/wayni/web'], children)).toEqual({ name: 'web', path: '/w/wayni/web', root: false })
    expect(attributeFolder('/w/wayni-old/api', ['/w/wayni'], children)).toBeNull()
    expect(attributeFolder('/elsewhere', ['/w/wayni'], children)).toBeNull()
    expect(attributeFolder('C:\\w\\repo\\src', ['C:\\w\\repo'])?.name).toBe('repo')
  })
})

describe('folderSpend', () => {
  it('sums a profile’s folders over the window, per agent, largest first', () => {
    const b: SpendBuckets = {}
    addSpend(b, at('2026-10-27T10:00:00'), 'claude', '/w/wayni/api', 100)
    addSpend(b, at('2026-10-26T10:00:00'), 'codex', '/w/wayni/api/src', 50)
    addSpend(b, at('2026-10-26T10:00:00'), 'claude', '/w/wayni', 30)
    addSpend(b, at('2026-10-26T10:00:00'), 'kiro', '/w/repo', 200)
    addSpend(b, at('2026-10-26T10:00:00'), 'claude', '/other/project', 999)
    addSpend(b, at('2026-10-01T10:00:00'), 'claude', '/w/wayni/web', 999)
    const out = folderSpend(b, ['/w/wayni', '/w/repo'], { sinceDay: day('2026-10-21T12:00:00'), children: { '/w/wayni': ['api', 'web'] } })
    expect(out).toEqual([
      { name: 'repo', path: '/w/repo', root: false, tokens: 200, byAgent: { kiro: 200 } },
      { name: 'api', path: '/w/wayni/api', root: false, tokens: 150, byAgent: { claude: 100, codex: 50 } },
      { name: 'wayni', path: '/w/wayni', root: true, tokens: 30, byAgent: { claude: 30 } }
    ])
    expect(folderSpend(b, [], { sinceDay: '2026-10-21' })).toEqual([])
  })

  it('counts a worktree outside the folders for its main repository inside them', () => {
    const b: SpendBuckets = {}
    addSpend(b, at('2026-10-27T10:00:00'), 'claude', '/elsewhere/api-fix/src', 40)
    addSpend(b, at('2026-10-27T10:00:00'), 'codex', '/elsewhere/repo-wt', 10)
    addSpend(b, at('2026-10-27T10:00:00'), 'claude', '/elsewhere/unrelated', 5)
    const aliases = { '/elsewhere/api-fix': '/w/wayni/api', '/elsewhere/repo-wt': '/w/repo', '/elsewhere/unrelated': '/far/away' }
    const out = folderSpend(b, ['/w/wayni', '/w/repo'], { sinceDay: day('2026-10-21T12:00:00'), children: { '/w/wayni': ['api'] }, aliases })
    expect(out).toEqual([
      { name: 'api', path: '/w/wayni/api', root: false, tokens: 40, byAgent: { claude: 40 } },
      { name: 'repo', path: '/w/repo', root: false, tokens: 10, byAgent: { codex: 10 } }
    ])
    expect(aliasPath('/elsewhere/api-fix/src/a', aliases)).toBe('/w/wayni/api/src/a')
    expect(aliasPath('/elsewhere/api-fixed', aliases)).toBe('/elsewhere/api-fixed')
  })

  it('counts a live worktree next to its repository for the repository, not as a folder of its own', () => {
    const b: SpendBuckets = {}
    addSpend(b, at('2026-10-27T10:00:00'), 'claude', '/w/p/workhub2-chat/packages', 70)
    addSpend(b, at('2026-10-27T10:00:00'), 'claude', '/w/p/workhub2', 30)
    const out = folderSpend(b, ['/w/p'], { sinceDay: day('2026-10-21T12:00:00'), children: { '/w/p': ['workhub2', 'workhub2-chat'] }, aliases: { '/w/p/workhub2-chat': '/w/p/workhub2' } })
    expect(out).toEqual([{ name: 'workhub2', path: '/w/p/workhub2', root: false, tokens: 100, byAgent: { claude: 100 } }])
  })

  it('tells two folders of the same name apart by their parent', () => {
    const b: SpendBuckets = {}
    addSpend(b, at('2026-10-27T10:00:00'), 'claude', '/w/p/shop', 50)
    addSpend(b, at('2026-10-27T10:00:00'), 'claude', '/opt/shop', 10)
    const out = folderSpend(b, ['/w/p'], { sinceDay: day('2026-10-21T12:00:00'), children: { '/w/p': ['shop'] }, owns: () => true })
    expect(out.map((e) => e.name)).toEqual(['p/shop', 'opt/shop'])
  })
})
