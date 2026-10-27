import { describe, expect, it } from 'vitest'
import { readKeychainItem, type SecurityRunner } from '../src/workhub1-import'

const SECRET = 'S3CRET-token-value-123'

describe('readKeychainItem', () => {
  it('runs /usr/bin/security with plain arguments, no shell, and returns the value', async () => {
    const calls: { file: string; args: string[] }[] = []
    const run: SecurityRunner = async (file, args) => {
      calls.push({ file, args })
      return { code: 0, stdout: `${SECRET}\n` }
    }
    const r = await readKeychainItem({ service: 'svc; rm -rf', account: 'user' }, 'darwin', run)
    expect(r).toEqual({ status: 'found', value: `${SECRET}\n` })
    expect(calls).toEqual([{ file: '/usr/bin/security', args: ['find-generic-password', '-s', 'svc; rm -rf', '-a', 'user', '-w'] }])
  })

  it('leaves -a out without an account', async () => {
    let seen: string[] = []
    await readKeychainItem({ service: 'svc' }, 'darwin', async (_f, args) => ((seen = args), { code: 44, stdout: '' }))
    expect(seen).toEqual(['find-generic-password', '-s', 'svc', '-w'])
  })

  it('maps exit codes to statuses without any output in the result', async () => {
    const at = (code: number | null, timedOut = false) => readKeychainItem({ service: 's' }, 'darwin', async () => ({ code, stdout: SECRET, timedOut }))
    expect(await at(44)).toEqual({ status: 'notFound' })
    expect(await at(128)).toEqual({ status: 'denied' })
    expect(await at(51)).toEqual({ status: 'denied' })
    expect(await at(1)).toEqual({ status: 'error', code: 'exit-1' })
    expect(await at(null)).toEqual({ status: 'error', code: 'spawn-failed' })
    expect(await at(null, true)).toEqual({ status: 'error', code: 'timeout' })
    for (const c of [44, 128, 1, null]) expect(JSON.stringify(await at(c))).not.toContain(SECRET)
  })

  it('does nothing outside macOS', async () => {
    let ran = false
    const r = await readKeychainItem({ service: 's' }, 'linux', async () => ((ran = true), { code: 0, stdout: SECRET }))
    expect(r).toEqual({ status: 'error', code: 'unsupported-platform' })
    expect(ran).toBe(false)
  })
})
