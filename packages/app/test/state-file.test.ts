import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateFile } from '../src/main/state-file'

describe('StateFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workhub-state-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the pending value on flush', () => {
    const file = new StateFile<{ n: number }>(join(dir, 'state.json'), 10_000)
    file.save({ n: 1 })
    file.save({ n: 2 })
    file.flush()
    expect(JSON.parse(readFileSync(file.path, 'utf8'))).toEqual({ n: 2 })
  })

  it('keeps the value when a write fails, removes its temp file and writes it on the next try', () => {
    const path = join(dir, 'state.json')
    // A folder in the file's place: the final rename fails.
    mkdirSync(path)
    writeFileSync(join(path, 'keep'), 'x')
    const logged: string[] = []
    const file = new StateFile<{ n: number }>(path, 10_000, (m) => logged.push(m))
    file.save({ n: 1 })
    expect(() => file.flush()).not.toThrow()
    expect(logged).toHaveLength(1)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])

    rmSync(path, { recursive: true })
    file.flush()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ n: 1 })
    expect(readdirSync(dir)).toEqual(['state.json'])
  })
})
