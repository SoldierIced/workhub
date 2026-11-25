// The review window's file paths with Windows path semantics (as on a Windows runner): a session on
// this computer keeps them, whatever its root looks like.
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:path', async () => {
  const path = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...path.win32, default: path.win32 }
})

describe('insideRoot on Windows', () => {
  it("resolves a local session's file with Windows semantics, and a host session's as POSIX", async () => {
    const { insideRoot } = await import('../src/main/local-review')
    const { win32 } = await vi.importActual<typeof import('node:path')>('node:path')
    expect(insideRoot('/w/app', 'src/a.ts')).toBe(win32.resolve('/w/app/src/a.ts'))
    expect(insideRoot('/home/ana/acme', 'src/a.ts', true)).toBe('/home/ana/acme/src/a.ts')
    expect(insideRoot('/w/app', '..\\etc\\passwd')).toBeNull()
  })
})
