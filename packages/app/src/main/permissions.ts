/**
 * Web permissions the renderer may get. Everything is denied (camera, microphone, geolocation,
 * notifications, MIDI, HID, serial, ...) except writing plain text to the clipboard, and only for
 * the app's own renderer. OS notifications come from the main process and need no web permission.
 */
const ALLOWED = new Set(['clipboard-sanitized-write'])

export function permissionAllowed(permission: string, url: string | null | undefined, isTrusted: (url: string | null) => boolean): boolean {
  return ALLOWED.has(permission) && isTrusted(url ?? null)
}
