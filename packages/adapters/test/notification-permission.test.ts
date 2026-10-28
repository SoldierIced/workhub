import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundleIdFromInfoPlist, notificationPermissionFromNcprefs, readNotificationPermission } from '../src/shared/notification-permission'

const ncprefs = readFileSync(join(__dirname, 'fixtures', 'ncprefs.plist'), 'utf8')
const info = (id: string) => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>X</string><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`

describe('notificationPermissionFromNcprefs', () => {
  it('reads the "Allow notifications" bit of the app entry', () => {
    expect(notificationPermissionFromNcprefs(ncprefs, 'io.github.soldiericed.workhub2')).toBe('allowed')
    expect(notificationPermissionFromNcprefs(ncprefs, 'com.github.electron')).toBe('denied')
  })

  it('is unknown for an app not listed, an entry without flags, or an unreadable export', () => {
    expect(notificationPermissionFromNcprefs(ncprefs, 'com.example.missing')).toBe('unknown')
    expect(notificationPermissionFromNcprefs(ncprefs, 'com.example.noflags')).toBe('unknown')
    expect(notificationPermissionFromNcprefs('<plist version="1.0"><dict/></plist>', 'x')).toBe('unknown')
    expect(notificationPermissionFromNcprefs('not a plist', 'x')).toBe('unknown')
  })
})

describe('readNotificationPermission', () => {
  it('finds the bundle id next to the executable, then reads the preferences', async () => {
    const reads: string[] = []
    const result = await readNotificationPermission({
      execPath: '/Applications/Workhub 2.app/Contents/MacOS/Workhub 2',
      readText: async (p) => {
        reads.push(p)
        return info('io.github.soldiericed.workhub2')
      },
      exportNcprefs: async () => ncprefs
    })
    expect(result).toBe('allowed')
    expect(reads).toEqual([join('/Applications/Workhub 2.app/Contents', 'Info.plist')])
  })

  it('is unknown without a bundle id or without the preferences (macOS 15 and later)', async () => {
    expect(await readNotificationPermission({ execPath: '/x/y', readText: () => Promise.reject(new Error('no')), exportNcprefs: async () => ncprefs })).toBe('unknown')
    expect(await readNotificationPermission({ execPath: '/x/y', readText: async () => info('io.github.soldiericed.workhub2'), exportNcprefs: () => Promise.reject(new Error('no')) })).toBe('unknown')
    expect(bundleIdFromInfoPlist('<plist><dict/></plist>')).toBeUndefined()
  })
})
