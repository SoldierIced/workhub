/** The subset of a GitHub release (api.github.com/repos/<owner>/<repo>/releases) the picker reads. */
export interface ReleaseSummary {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: readonly { name: string }[]
}

/** The electron-updater manifest each platform downloads from a release. */
export const UPDATE_MANIFEST: Record<string, string> = { darwin: 'latest-mac.yml', win32: 'latest.yml', linux: 'latest-linux.yml' }

/**
 * The tag of the newest release that can actually be installed: published (never a draft), a
 * pre-release only when the running version is one, and with this platform's manifest among its
 * assets. A tag whose installers are still being built, or a draft, is skipped instead of making
 * the check fail with "Cannot find latest-mac.yml". `releases` comes newest first, as the API lists them.
 */
export function pickReleaseTag(releases: readonly ReleaseSummary[], opts: { prerelease: boolean; platform: string }): string | undefined {
  const manifest = UPDATE_MANIFEST[opts.platform]
  if (!manifest) return undefined
  return releases.find((r) => !r.draft && (opts.prerelease || !r.prerelease) && r.assets.some((a) => a.name === manifest))?.tag_name
}
