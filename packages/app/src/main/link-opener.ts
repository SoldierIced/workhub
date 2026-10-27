/** How to open a web link in a profile's own browser; null means "use the default browser". */
export interface LinkCommand {
  command: string
  args: string[]
}

/**
 * `browser` is an application name on macOS (`Google Chrome`: `open -a`) and an executable on
 * Windows and Linux. The link is always one argument, never part of a shell string.
 */
export function linkCommand(platform: NodeJS.Platform, browser: string | undefined, url: string): LinkCommand | null {
  const app = browser?.trim()
  if (!app || !/^https?:\/\//i.test(url)) return null
  if (platform === 'darwin') return { command: 'open', args: ['-a', app, url] }
  return { command: app, args: [url] }
}
