// Settings → Profiles → "Where sessions run": the choice between this computer and a WSL
// distribution (`profile.host`), and the folders such a profile takes (POSIX paths in the
// distribution, translated from the `\\wsl.localhost\<distro>\...` a Windows folder picker gives).
import { hostIdOf, isAbsoluteFlavorPath, wslUncToPosix, type Profile, type ProfileHost, type WslDistro } from '@workhub/core'
import type { MessageKey } from '../i18n/translate'

/** The select's value for this computer. */
export const LOCAL_HOST_OPTION = 'local'

/** The select's value of a host: `local` or `wsl:<distro>` (the host's id). */
export function hostOptionValue(host: ProfileHost | undefined): string {
  return host ? hostIdOf(host) : LOCAL_HOST_OPTION
}

/** The host a select value names; undefined for this computer (a profile without `host`). */
export function hostOfOptionValue(value: string): ProfileHost | undefined {
  return value.startsWith('wsl:') && value.length > 4 ? { kind: 'wsl', distro: value.slice(4) } : undefined
}

/** The profile running on `host`: this computer is the default, so it is saved as no `host` at all. */
export function withProfileHost(profile: Profile, host: ProfileHost | undefined): Profile {
  const { host: _old, ...rest } = profile
  return host && host.kind === 'wsl' ? { ...rest, host } : rest
}

export interface HostChoice {
  value: string
  /** `local`, or the distribution's name. */
  distro: string | null
  isDefault: boolean
  /** A distribution the profile names that WSL no longer lists. */
  missing: boolean
}

/** This computer, the installed distributions (in WSL's order), and the profile's own when it is not among them. */
export function hostChoices(distros: readonly WslDistro[], current: ProfileHost | undefined): HostChoice[] {
  const out: HostChoice[] = [{ value: LOCAL_HOST_OPTION, distro: null, isDefault: false, missing: false }]
  for (const d of distros) out.push({ value: hostIdOf({ kind: 'wsl', distro: d.name }), distro: d.name, isDefault: d.isDefault, missing: false })
  if (current?.kind === 'wsl' && !distros.some((d) => d.name === current.distro)) out.push({ value: hostIdOf(current), distro: current.distro, isDefault: false, missing: true })
  return out
}

export type HostFolder = { ok: true; path: string } | { ok: false; error: MessageKey; params: Record<string, string> }

/**
 * A folder the user picked, as the profile stores it: unchanged for this computer; for a WSL
 * profile, the POSIX path of a `\\wsl.localhost\<distro>\...` (or `\\wsl$\...`) folder of that
 * distribution, a POSIX path as it is, and an error for any other Windows path.
 */
export function folderForHost(host: ProfileHost | undefined, picked: string): HostFolder {
  if (host?.kind !== 'wsl') return { ok: true, path: picked }
  const unc = wslUncToPosix(picked)
  if (unc) {
    if (unc.distro.toLowerCase() !== host.distro.toLowerCase()) return { ok: false, error: 'profileHost.folderOtherDistro', params: { picked: unc.distro, distro: host.distro } }
    return { ok: true, path: unc.path }
  }
  if (isAbsoluteFlavorPath('posix', picked)) return { ok: true, path: picked }
  return { ok: false, error: 'profileHost.folderNotWsl', params: { distro: host.distro } }
}

/** A folder picker's refusal, with the folders and host it was raised for. */
export interface FolderPickError {
  message: string
  key: string
}

const folderPickKey = (folders: readonly string[] | undefined, host: ProfileHost | undefined): string => JSON.stringify([hostOptionValue(host), folders ?? []])

/** A picker's refusal of a folder, for the profile's folders and host at that moment. */
export function folderPickError(message: string, folders: readonly string[] | undefined, host: ProfileHost | undefined): FolderPickError {
  return { message, key: folderPickKey(folders, host) }
}

/**
 * The refusal to show: none once the profile's folders or its host changed since (a valid folder
 * was added, by this picker or another one of the form, or the host was switched).
 */
export function shownFolderError(error: FolderPickError | null, folders: readonly string[] | undefined, host: ProfileHost | undefined): string | null {
  return error && error.key === folderPickKey(folders, host) ? error.message : null
}
