import { describe, expect, it } from 'vitest'
import { filterFromLists, linesOf } from '../src/renderer/screens/settings/PullRequestsFilter'

describe('Settings → Pull requests filter form', () => {
  it('reads one entry per line, also split by commas or spaces', () => {
    expect(linesOf(' acme\n\nana, other  x\n')).toEqual(['acme', 'ana', 'other', 'x'])
  })
  it('stores only the lists that hold something, nothing when both are empty', () => {
    expect(filterFromLists([], [])).toBeUndefined()
    expect(filterFromLists(['acme'], [])).toEqual({ owners: ['acme'] })
    expect(filterFromLists([], ['acme/api'])).toEqual({ excludeRepos: ['acme/api'] })
  })
})
