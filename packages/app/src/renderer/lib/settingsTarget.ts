/** A Settings target as links and the menu bar name it: `general`, or `general#updates` for one group of a tab. */
export function parseSettingsTarget(target: string | undefined): { tab?: string; group?: string } {
  const [tab, group] = (target ?? '').split('#', 2)
  return { ...(tab ? { tab } : {}), ...(group ? { group } : {}) }
}
