import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startControlServer } from '../src/main/control-server'
import { flowMapSummaries, readFlowMapFiles, saveFlowMap } from '../src/main/flow-maps'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wh-flow-maps-'))
  dirs.push(d)
  return d
}

const checkout = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'docs', 'examples', 'flow-maps', 'checkout.json'), 'utf8')) as Record<string, unknown>

describe('flow-map files', () => {
  it('lists every json of the folder, the bad ones with their error, and none without a folder', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'checkout.json'), JSON.stringify(checkout))
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    writeFileSync(join(dir, 'refs.json'), JSON.stringify({ ...checkout, id: 'refs', edges: [{ from: 'bff', to: 'nowhere' }] }))
    writeFileSync(join(dir, 'notes.txt'), 'ignored')
    const files = readFlowMapFiles(dir)
    expect(files.map((f) => [f.file.split('/').pop(), Boolean(f.map)])).toEqual([['broken.json', false], ['checkout.json', true], ['refs.json', false]])
    const summaries = flowMapSummaries(files)
    expect(summaries[1]).toMatchObject({ id: 'checkout', name: 'Checkout', nodes: 6, edges: 6 })
    expect(summaries[0]).toMatchObject({ id: 'broken', error: expect.stringContaining('JSON') })
    expect(summaries[2]?.error).toContain('unknown node "nowhere"')
    expect(readFlowMapFiles(join(dir, 'missing'))).toEqual([])
  })

  it('saves a valid map under its id and refuses an invalid one with the field errors', () => {
    const dir = join(tmp(), 'flow-maps')
    const saved = saveFlowMap(dir, checkout)
    expect(saved).toMatchObject({ ok: true, id: 'checkout', file: join(dir, 'checkout.json') })
    expect(readFlowMapFiles(dir)[0]?.map?.name).toBe('Checkout')
    const bad = saveFlowMap(dir, { ...checkout, lanes: [] })
    expect(bad).toMatchObject({ ok: false, errors: [expect.stringContaining('lanes')] })
  })

  it('takes a map over the control endpoint', async () => {
    const dir = tmp()
    const socket = join(dir, 'c.sock')
    const stored: unknown[] = []
    const server = await startControlServer(socket, {
      openReview: () => ({ ok: true }),
      saveFlowMap: (map) => {
        stored.push(map)
        return saveFlowMap(join(dir, 'flow-maps'), map)
      }
    })
    expect(server).not.toBeNull()
    const call = (body: unknown) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const req = request({ socketPath: socket, method: 'POST', path: '/v1/flow-maps', headers: { 'content-type': 'application/json' } }, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
        })
        req.on('error', reject)
        req.end(JSON.stringify(body))
      })
    try {
      const ok = await call(checkout)
      expect(ok.status).toBe(200)
      expect(ok.json).toMatchObject({ ok: true, id: 'checkout' })
      expect(readFlowMapFiles(join(dir, 'flow-maps'))).toHaveLength(1)
      const bad = await call({ version: 1 })
      expect(bad.status).toBe(400)
      expect(bad.json.errors).toEqual(expect.arrayContaining([expect.stringContaining('id')]))
    } finally {
      await new Promise((r) => server!.close(r))
    }
  })
})
