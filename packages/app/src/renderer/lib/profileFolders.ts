/** A folder path compared without its trailing separators (`/a/b/` is `/a/b`). */
const comparable = (path: string): string => {
  const trimmed = path.trim()
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, '') || trimmed : trimmed
}

/**
 * A profile's folders with `picked` added at the end. A blank pick, or a folder already listed
 * (trailing separators ignored), leaves the list as it is.
 */
export function addProfileFolder(folders: readonly string[] | undefined, picked: string): string[] {
  const list = [...(folders ?? [])]
  const path = comparable(picked)
  if (!path || list.some((f) => comparable(f) === path)) return list
  return [...list, path]
}

/** A profile's folders without `folder`; undefined once none is left (the profile has no folders). */
export function removeProfileFolder(folders: readonly string[] | undefined, folder: string): string[] | undefined {
  const list = (folders ?? []).filter((f) => f !== folder)
  return list.length ? list : undefined
}
