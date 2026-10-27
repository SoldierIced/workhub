/**
 * Whether macOS lets this app show notifications. Electron has no API for it, so this reads the
 * app's entry in Notification Center's preferences (`com.apple.ncprefs`), read-only, through
 * `defaults export com.apple.ncprefs -`. Those preferences are only readable up to macOS 14:
 * later versions keep them where an app cannot read them, and the answer is `unknown`.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parsePlist, type PlistValue } from '../workhub1-import'

export type NotificationPermission = 'allowed' | 'denied' | 'unknown'

/** The "Allow notifications" switch in an app's `flags` (bit 25). */
export const NC_ALLOW_NOTIFICATIONS = 1 << 25

const isRecord = (v: PlistValue | undefined): v is Record<string, PlistValue> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array)

/** The app's permission from an export of `com.apple.ncprefs`; `unknown` when the app is not listed or the export cannot be read. */
export function notificationPermissionFromNcprefs(xml: string, bundleId: string): NotificationPermission {
  let root: PlistValue
  try {
    root = parsePlist(xml)
  } catch {
    return 'unknown'
  }
  if (!isRecord(root) || !Array.isArray(root['apps'])) return 'unknown'
  const wanted = bundleId.toLowerCase()
  const entry = root['apps'].find((a): a is Record<string, PlistValue> => isRecord(a) && typeof a['bundle-id'] === 'string' && a['bundle-id'].toLowerCase() === wanted)
  const flags = entry?.['flags']
  if (typeof flags !== 'number' || !Number.isInteger(flags)) return 'unknown'
  return (flags & NC_ALLOW_NOTIFICATIONS) !== 0 ? 'allowed' : 'denied'
}

/** `CFBundleIdentifier` of an XML `Info.plist`. */
export function bundleIdFromInfoPlist(xml: string): string | undefined {
  try {
    const root = parsePlist(xml)
    const id = isRecord(root) ? root['CFBundleIdentifier'] : undefined
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

export interface NotificationPermissionDeps {
  /** The running executable (`process.execPath`): `<App>.app/Contents/MacOS/<name>`. */
  execPath: string
  readText?: (path: string) => Promise<string>
  /** Prints the Notification Center preferences as an XML property list. */
  exportNcprefs?: () => Promise<string>
}

const exportNcprefs = (): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile('defaults', ['export', 'com.apple.ncprefs', '-'], { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  )

/** Reads the running app's notification permission on macOS; never writes anything. */
export async function readNotificationPermission(deps: NotificationPermissionDeps): Promise<NotificationPermission> {
  const read = deps.readText ?? ((p: string) => readFile(p, 'utf8'))
  const info = await read(join(dirname(deps.execPath), '..', 'Info.plist')).catch(() => null)
  const bundleId = info ? bundleIdFromInfoPlist(info) : undefined
  if (!bundleId) return 'unknown'
  const xml = await (deps.exportNcprefs ?? exportNcprefs)().catch(() => null)
  return xml ? notificationPermissionFromNcprefs(xml, bundleId) : 'unknown'
}
