import type { PullRequestRef } from './domain'

/** One recognizer per host: a URL is a pull/merge request of the host or it is not. */
export interface PullRequestUrlRecognizer {
  readonly provider: string
  parse(url: string): PullRequestRef | null
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function hostPattern(host: string): string {
  return escape(host.replace(/^https?:\/\//, '').replace(/\/+$/, ''))
}

/** `https://<host>/<owner>/<repo>/pull/<n>`; `host` defaults to github.com (set it for GitHub Enterprise). */
export function githubRecognizer(host = 'github.com'): PullRequestUrlRecognizer {
  const re = new RegExp(`^https?://(?:www\\.)?${hostPattern(host)}/([\\w.-]+)/([\\w.-]+)/pull/(\\d+)(?:[/?#].*)?$`, 'i')
  return {
    provider: 'github',
    parse(url) {
      const m = re.exec(url.trim())
      if (!m) return null
      const [, owner, repo, n] = m
      return { provider: 'github', owner: owner!, repo: repo!, number: Number(n), url: `https://${host.replace(/^https?:\/\//, '')}/${owner}/${repo}/pull/${n}` }
    }
  }
}

/** `https://<host>/<group>[/<subgroup>…]/<project>/-/merge_requests/<n>`; `owner` is the group path. */
export function gitlabRecognizer(host = 'gitlab.com'): PullRequestUrlRecognizer {
  const re = new RegExp(`^https?://${hostPattern(host)}/((?:[\\w.-]+/)+)([\\w.-]+)/-/merge_requests/(\\d+)(?:[/?#].*)?$`, 'i')
  return {
    provider: 'gitlab',
    parse(url) {
      const m = re.exec(url.trim())
      if (!m) return null
      const [, groups, project, n] = m
      const owner = groups!.replace(/\/$/, '')
      return {
        provider: 'gitlab',
        owner,
        repo: project!,
        number: Number(n),
        url: `https://${host.replace(/^https?:\/\//, '')}/${owner}/${project}/-/merge_requests/${n}`
      }
    }
  }
}

/** The project path GitLab's API wants, URL-encoded (`group%2Fproject`). */
export function gitlabProjectPath(ref: Pick<PullRequestRef, 'owner' | 'repo'>): string {
  return encodeURIComponent(`${ref.owner}/${ref.repo}`)
}

const URL_IN_TEXT = /https?:\/\/[^\s<>()"'\]]+/g

/** Every PR/MR reference in a text, normalized, in order and without repeats. */
export function findPullRequestRefs(text: string, recognizers: readonly PullRequestUrlRecognizer[]): PullRequestRef[] {
  const seen = new Set<string>()
  const out: PullRequestRef[] = []
  for (const match of text.matchAll(URL_IN_TEXT)) {
    for (const r of recognizers) {
      const ref = r.parse(match[0].replace(/[.,;:]+$/, ''))
      if (ref && !seen.has(canonicalUrl(ref.url))) {
        seen.add(canonicalUrl(ref.url))
        out.push(ref)
        break
      }
    }
  }
  return out
}

/** The comparison key of a PR URL: lowercased, without `/files`, query, fragment or trailing slash. */
export function canonicalUrl(url: string): string {
  const clean = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '')
  return clean.replace(/\/(pull\/\d+|merge_requests\/\d+)\/.*$/, '/$1').toLowerCase()
}

/** `owner/repo` of a GitHub remote URL (https or ssh), or null. */
export function githubSlugFromRemote(remote: string, host = 'github.com'): string | null {
  const m = new RegExp(`${hostPattern(host)}[:/]([\\w.-]+)/([\\w.-]+?)(?:\\.git)?/?$`, 'i').exec(remote.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** A GitHub search scope for the repos behind some git remotes (`repo:a/b repo:c/d`); empty when none is on GitHub. */
export function githubScopeFromRemotes(remotes: readonly string[], host = 'github.com'): string {
  const slugs = new Set<string>()
  for (const r of remotes) {
    const slug = githubSlugFromRemote(r, host)
    if (slug) slugs.add(slug)
  }
  return [...slugs].sort().map((s) => `repo:${s}`).join(' ')
}
