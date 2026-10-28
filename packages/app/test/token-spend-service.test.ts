import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyConfig, type Profile, type WorkhubConfig } from '@workhub/core'
import type { SpendCache } from '@workhub/adapters/token-spend'
import { spendSources, TokenSpendService } from '../src/main/token-spend'

const profile = (id: string, folders: string[], extra: Partial<Profile> = {}): Profile => ({ id, name: id, connections: {}, accountIds: [], modules: {} as Profile['modules'], folders, ...extra })

function memoryStore(initial: SpendCache | null = null) {
  let value = initial
  let saves = 0
  return {
    load: (fallback: SpendCache) => value ?? fallback,
    save: (v: SpendCache) => {
      value = v
      saves++
    },
    flush: () => {},
    get saves() {
      return saves
    },
    get value() {
      return value
    }
  }
}

describe('TokenSpendService', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wh-spend-svc-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('counts a worktree outside the profile folders for its repository inside them', async () => {
    const work = join(root, 'work')
    const main = join(work, 'api')
    mkdirSync(join(main, '.git', 'worktrees', 'api-fix'), { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'api-fix', 'commondir'), '../..\n')
    const wt = join(root, 'api-fix')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'api-fix')}\n`)
    const project = join(root, '.claude', 'projects', 'p')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'a.jsonl'), JSON.stringify({ type: 'assistant', cwd: wt, timestamp: new Date().toISOString(), message: { id: 'm1', usage: { input_tokens: 7, output_tokens: 0 } } }) + '\n')
    const config: WorkhubConfig = { ...emptyConfig(), profiles: [profile('one', [work])], activeProfileId: 'one' }
    const svc = new TokenSpendService({ config: async () => config, store: memoryStore(), sources: async () => ({ claudeDirs: [join(root, '.claude')], codexHomes: [], kiroDirs: [] }), emit: () => {} })
    await svc.refresh()
    expect((await svc.forProfile('one')).entries).toMatchObject([{ name: 'api', path: main.replaceAll('\\', '/'), tokens: 7 }])
  })

  it('scans at start-up, keeps each profile to its own folders, and persists the cache', async () => {
    const work = join(root, 'work')
    mkdirSync(join(work, 'api'), { recursive: true })
    mkdirSync(join(work, 'web'), { recursive: true })
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    const project = join(root, '.claude', 'projects', 'p')
    mkdirSync(project, { recursive: true })
    const line = (cwd: string, id: string, tokens: number) =>
      JSON.stringify({ type: 'assistant', cwd, timestamp: new Date().toISOString(), message: { id, usage: { input_tokens: tokens, output_tokens: 0 } } })
    writeFileSync(join(project, 'a.jsonl'), [line(join(work, 'api'), 'm1', 10), line(join(work, 'web'), 'm2', 30), line(join(root, 'repo', 'src'), 'm3', 5)].join('\n') + '\n')

    const config: WorkhubConfig = { ...emptyConfig(), profiles: [profile('one', [work], { folderOptions: { [work]: { subfoldersAreProjects: true } } }), profile('two', [join(root, 'repo')])], activeProfileId: 'one' }
    const store = memoryStore()
    let emitted = 0
    const svc = new TokenSpendService({
      config: async () => config,
      store,
      sources: async () => ({ claudeDirs: [join(root, '.claude')], codexHomes: [], kiroDirs: [] }),
      emit: () => emitted++
    })
    const before = await svc.forProfile('one')
    expect(before.scannedAt).toBeNull()
    expect(before.entries).toEqual([])

    await svc.refresh()
    expect(emitted).toBe(1)
    expect(store.saves).toBe(1)
    const one = await svc.forProfile(null)
    expect(one.hasFolders).toBe(true)
    expect(one.entries.map((e) => [e.name, e.tokens])).toEqual([
      ['web', 30],
      ['api', 10]
    ])
    expect((await svc.forProfile('two')).entries.map((e) => [e.name, e.tokens])).toEqual([['repo', 5]])

    // A new run starts from the persisted cache, before its first scan.
    const again = new TokenSpendService({ config: async () => config, store, sources: async () => ({ claudeDirs: [], codexHomes: [], kiroDirs: [] }), emit: () => {} })
    expect((await again.forProfile('one')).entries.map((e) => e.tokens)).toEqual([30, 10])
  })

  it('says when a profile has no folders', async () => {
    const config: WorkhubConfig = { ...emptyConfig(), profiles: [profile('one', [])] }
    const svc = new TokenSpendService({ config: async () => config, store: memoryStore(), sources: async () => ({ claudeDirs: [], codexHomes: [], kiroDirs: [] }), emit: () => {} })
    expect((await svc.forProfile('one')).hasFolders).toBe(false)
  })

  it('splits a folder into its subfolders only when they are projects, and leaves out what another profile owns', async () => {
    const box = join(root, 'box')
    for (const d of ['api', 'web', 'web/.git', '.hidden', 'other']) mkdirSync(join(box, d), { recursive: true })
    const project = join(root, '.claude', 'projects', 'p')
    mkdirSync(project, { recursive: true })
    const line = (cwd: string, id: string, tokens: number) =>
      JSON.stringify({ type: 'assistant', cwd, timestamp: new Date().toISOString(), message: { id, usage: { input_tokens: tokens, output_tokens: 0 } } })
    const lines = [line(join(box, 'api'), 'm1', 10), line(join(box, 'web', 'src'), 'm2', 20), line(join(box, 'other'), 'm3', 40), line('/srv/elsewhere', 'm4', 7), line('/tmp/scratch', 'm5', 3)]
    writeFileSync(join(project, 'a.jsonl'), lines.join('\n') + '\n')
    const options = { [box]: { subfoldersAreProjects: true, onlyGitRepos: true } }
    let config: WorkhubConfig = {
      ...emptyConfig(),
      profiles: [profile('one', [box], { folderOptions: options }), profile('two', [join(box, 'other')], { ownsOutside: true })],
      activeProfileId: 'one'
    }
    const svc = new TokenSpendService({ config: async () => config, store: memoryStore(), sources: async () => ({ claudeDirs: [join(root, '.claude')], codexHomes: [], kiroDirs: [] }), emit: () => {} })
    await svc.refresh()
    // Only `web` is a git repository, so `api` work counts at the folder's root; `other` belongs to profile two.
    expect((await svc.forProfile('one')).entries.map((e) => [e.name, e.root, e.tokens])).toEqual([
      ['web', false, 20],
      ['box', true, 10]
    ])
    // Profile two owns its folder and everything outside every profile (throwaway folders left out).
    expect((await svc.forProfile('two')).entries.map((e) => [e.name, e.tokens])).toEqual([
      ['other', 40],
      ['elsewhere', 7]
    ])
    // Switched off, the folder is one project.
    config = { ...config, profiles: [profile('one', [box], { folderOptions: { [box]: { subfoldersAreProjects: false } } }), config.profiles[1]!] }
    expect((await svc.forProfile('one')).entries.map((e) => [e.name, e.tokens])).toEqual([['box', 30]])
    // Never set (profiles imported before the switch): a folder that is not a repository is split, as before.
    config = { ...config, profiles: [profile('one', [box]), config.profiles[1]!] }
    expect((await svc.forProfile('one')).entries.map((e) => [e.name, e.tokens])).toEqual([
      ['web', 20],
      ['api', 10]
    ])
    mkdirSync(join(box, '.git'))
    expect((await svc.forProfile('one')).entries.map((e) => [e.name, e.tokens])).toEqual([['box', 30]])
  })

  it('lists every Claude install', async () => {
    mkdirSync(join(root, '.claude-work'), { recursive: true })
    writeFileSync(join(root, '.claude.json'), '{}')
    const sources = await spendSources(emptyConfig(), root, undefined, {})
    expect([...sources.claudeDirs].sort()).toEqual([join(root, '.claude'), join(root, '.claude-work')])
    expect(sources.codexHomes).toEqual([join(root, '.codex')])
    expect(sources.kiroDirs).toEqual([join(root, '.kiro')])
  })
})
