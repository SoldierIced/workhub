import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renameWithRetry, writeFileAtomic } from '../src/shared/atomic-file'

const errno = (code: string) => Object.assign(new Error(code), { code })

describe('renameWithRetry', () => {
  it('retries the transient Windows errors, then succeeds', async () => {
    const codes = ['EPERM', 'EBUSY', 'EACCES']
    let calls = 0
    await renameWithRetry('a', 'b', async () => {
      calls++
      const code = codes.shift()
      if (code) throw errno(code)
    }, [0, 0, 0, 0])
    expect(calls).toBe(4)
  })

  it('gives up after the last delay, and at once on other errors', async () => {
    let calls = 0
    await expect(renameWithRetry('a', 'b', async () => (calls++, Promise.reject(errno('EBUSY'))), [0, 0])).rejects.toMatchObject({ code: 'EBUSY' })
    expect(calls).toBe(3)
    calls = 0
    await expect(renameWithRetry('a', 'b', async () => (calls++, Promise.reject(errno('ENOENT'))), [0, 0])).rejects.toMatchObject({ code: 'ENOENT' })
    expect(calls).toBe(1)
  })
})

describe('writeFileAtomic', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wh2-atomic-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the file and leaves no temp file behind', async () => {
    const file = join(dir, 'nested', 'config.json')
    await writeFileAtomic(file, '{"a":1}')
    await writeFileAtomic(file, '{"a":2}')
    expect(readFileSync(file, 'utf8')).toBe('{"a":2}')
    expect(readdirSync(join(dir, 'nested'))).toEqual(['config.json'])
  })
})
