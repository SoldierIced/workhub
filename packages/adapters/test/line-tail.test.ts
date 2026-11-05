import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LineTail } from '../src/shared/reader-utils'

describe('LineTail', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wh2-tail-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const line = Buffer.from('{"text":"ship it 🚀"}\n', 'utf8')
  // Inside the rocket's four bytes.
  const cut = line.indexOf(Buffer.from('🚀', 'utf8')) + 2

  it('decodes a character split across two reads', async () => {
    const file = join(dir, 'a.jsonl')
    writeFileSync(file, line.subarray(0, cut))
    const tail = new LineTail(file)
    const lines: string[] = []
    expect(await tail.read((l) => lines.push(l))).toBe(true)
    expect(lines).toEqual([])
    appendFileSync(file, line.subarray(cut))
    await tail.read((l) => lines.push(l))
    expect(lines).toEqual(['{"text":"ship it 🚀"}'])
  })

  it('reads a file in chunks, also across a split character, and only what was appended later', async () => {
    const file = join(dir, 'b.jsonl')
    writeFileSync(file, Buffer.concat([line, Buffer.from('\n'), line]))
    const tail = new LineTail(file, cut)
    const lines: string[] = []
    await tail.read((l) => lines.push(l))
    expect(lines).toEqual(['{"text":"ship it 🚀"}', '{"text":"ship it 🚀"}'])
    appendFileSync(file, 'next\n')
    await tail.read((l) => lines.push(l))
    expect(lines.at(-1)).toBe('next')
    expect(lines).toHaveLength(3)
  })

  it('reports a missing file', async () => {
    expect(await new LineTail(join(dir, 'missing.jsonl')).read(() => {})).toBe(false)
  })
})
