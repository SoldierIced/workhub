/**
 * A Settings target as links and the menu bar name it: `general`, `general#updates` for one group
 * of a tab, or `profiles/<profileId>/<tab>` (also `profiles/<profileId>#<tab>`) for one tab of one
 * profile; `path` holds what follows the tab id.
 */
export function parseSettingsTarget(target: string | undefined): { tab?: string; group?: string; path?: string[] } {
  const [head = '', group] = (target ?? '').split('#', 2)
  const [tab, ...rest] = head.split('/')
  const path = rest.filter(Boolean)
  return { ...(tab ? { tab } : {}), ...(path.length ? { path } : {}), ...(group ? { group } : {}) }
}
