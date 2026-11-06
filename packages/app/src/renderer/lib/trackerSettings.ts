/** The settings keys of a tracker connection; the main process reads the same ones. */
export const TRACKER_SETTINGS = { email: 'email', projectKeys: 'projectKeys', ignored: 'ignoredStatuses' } as const

/** A Jira site as typed (`acme.atlassian.net`) made a URL. */
export const trackerSiteUrl = (site: string): string => (/^https?:\/\//i.test(site.trim()) ? site.trim() : `https://${site.trim()}`)
