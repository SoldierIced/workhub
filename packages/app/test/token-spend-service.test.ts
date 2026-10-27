import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyConfig, type Profile, type WorkhubConfig } from '@workhub/core'
import type { SpendCache } from '@workhub/adapters/token-spend'
import { childFolders, spendSources, TokenSpendService } from '../src/main/token-spend'

const profile = (id: string, folders: string[]): Profile => ({ id, name: id, connections: {}, accountIds: [], modules: {} as Profile['modules'], folders })

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

    const config: WorkhubConfig = { ...emptyConfig(), profiles: [profile('one', [work]), profile('two', [join(root, 'repo')])], activeProfileId: 'one' }
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

  it('splits only folders that are not repositories, and lists every Claude install', async () => {
    mkdirSync(join(root, 'box', 'api'), { recursive: true })
    mkdirSync(join(root, 'box', '.hidden'), { recursive: true })
    writeFileSync(join(root, 'box', 'file.txt'), '')
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    mkdirSync(join(root, 'repo', 'src'), { recursive: true })
    expect(await childFolders(join(root, 'box'))).toEqual(['api'])
    expect(await childFolders(join(root, 'repo'))).toEqual([])

    mkdirSync(join(root, '.claude-work'), { recursive: true })
    writeFileSync(join(root, '.claude.json'), '{}')
    const sources = await spendSources(emptyConfig(), root, undefined, {})
    expect([...sources.claudeDirs].sort()).toEqual([join(root, '.claude'), join(root, '.claude-work')])
    expect(sources.codexHomes).toEqual([join(root, '.codex')])
    expect(sources.kiroDirs).toEqual([join(root, '.kiro')])
  })
})
