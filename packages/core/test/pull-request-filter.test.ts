import { describe, expect, it } from 'vitest'
import { githubRepoScopeBatches, automationsForProfile, configSchema, filterPullRequests, githubScopeFromFilter, hasPullRequestFilter, matchesRepoPattern, normalizePullRequestFilter } from '../src'

const item = (owner: string, repo: string) => ({ pr: { owner, repo } })

describe('pull request filter per profile', () => {
  it('cleans the lists: trims, drops blanks, invalid entries, a leading @ and duplicates', () => {
    expect(normalizePullRequestFilter({ owners: [' acme ', '', '@ana', 'ACME', 'bad name'], excludeRepos: ['acme/api', 'nope', 'acme/API', 'acme/legacy-*'] })).toEqual({ owners: ['acme', 'ana'], excludeRepos: ['acme/api', 'acme/legacy-*'], repos: [] })
    expect(hasPullRequestFilter(undefined)).toBe(false)
    expect(hasPullRequestFilter({ owners: [' '] })).toBe(false)
    expect(hasPullRequestFilter({ excludeRepos: ['acme/api'] })).toBe(true)
  })

  it('matches repositories by name or by pattern, ignoring case', () => {
    expect(matchesRepoPattern('acme/API', ['acme/api'])).toBe(true)
    expect(matchesRepoPattern('acme/legacy-web', ['acme/legacy-*'])).toBe(true)
    expect(matchesRepoPattern('acme/web', ['acme/*'])).toBe(true)
    expect(matchesRepoPattern('acme/web', ['acme/we'])).toBe(false)
    expect(matchesRepoPattern('acme.io/web', ['acme/*'])).toBe(false)
  })

  it('keeps the owners\' pull requests and drops the hidden repositories', () => {
    const items = [item('acme', 'api'), item('acme', 'legacy-web'), item('ana', 'dotfiles'), item('other', 'x')]
    expect(filterPullRequests(items, undefined)).toEqual(items)
    expect(filterPullRequests(items, { owners: ['acme', 'ana'], excludeRepos: ['acme/legacy-*'] }).map((i) => `${i.pr.owner}/${i.pr.repo}`)).toEqual(['acme/api', 'ana/dotfiles'])
    expect(filterPullRequests(items, { excludeRepos: ['other/x'] })).toHaveLength(3)
  })

  it('reads GitLab subgroups under their parent group', () => {
    const items = [item('acme', 'acme/team/api'), item('acme', 'acme-labs/api')]
    expect(filterPullRequests(items, { owners: ['acme/team'] }).map((i) => i.pr.repo)).toEqual(['acme/team/api'])
    expect(filterPullRequests(items, { owners: ['acme'] }).map((i) => i.pr.repo)).toEqual(['acme/team/api'])
  })

  it('narrows the GitHub search with user: per owner and -repo: per exact hidden repository', () => {
    expect(githubScopeFromFilter({ excludeRepos: ['acme/api'] })).toBe('')
    expect(githubScopeFromFilter({ owners: ['acme', 'ana'], excludeRepos: ['acme/api', 'acme/legacy-*'] })).toBe('user:acme user:ana -repo:acme/api')
  })

  it('is stored on the profile', () => {
    const parsed = configSchema.safeParse({ version: 8, profiles: [{ id: 'work', name: 'Work', pullRequests: { owners: ['acme'], excludeRepos: ['acme/legacy-*'] } }] })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.profiles[0]?.pullRequests).toEqual({ owners: ['acme'], excludeRepos: ['acme/legacy-*'] })
  })
})

describe('automations per profile', () => {
  const list = [{ id: 'a', profileId: 'work' }, { id: 'b', profileId: 'home' }, { id: 'c', profileId: null }]
  it('lists the open profile\'s automations and those without one, or all of them', () => {
    expect(automationsForProfile(list, 'work', false).map((a) => a.id)).toEqual(['a', 'c'])
    expect(automationsForProfile(list, 'work', true).map((a) => a.id)).toEqual(['a', 'b', 'c'])
    expect(automationsForProfile(list, undefined, false)).toHaveLength(3)
  })
})

describe('repositories allowlist', () => {
  const items = [item('acme', 'api'), item('acme', 'web'), item('other', 'api')]
  it('keeps only the allowed repositories, whatever the owners, and excludes win', () => {
    expect(hasPullRequestFilter({ repos: ['acme/api'] })).toBe(true)
    expect(filterPullRequests(items, { owners: ['other'], repos: ['acme/api', 'acme/web'] }).map((i) => i.pr.repo)).toEqual(['api', 'web'])
    expect(filterPullRequests(items, { repos: ['acme/api', 'acme/web'], excludeRepos: ['acme/web'] })).toHaveLength(1)
  })
  it('searches with repo: qualifiers only and splits long lists', () => {
    expect(githubScopeFromFilter({ owners: ['acme'], repos: ['acme/api', 'acme/web'], excludeRepos: ['acme/web'] })).toBe('repo:acme/api')
    const repos = Array.from({ length: 50 }, (_, i) => `acme/service-number-${i}`)
    const batches = githubRepoScopeBatches({ repos })
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.every((b) => b.length <= 200)).toBe(true)
    expect(batches.join(' ').split(' ')).toHaveLength(50)
    expect(githubRepoScopeBatches({ owners: ['acme'] })).toEqual([])
  })
})
