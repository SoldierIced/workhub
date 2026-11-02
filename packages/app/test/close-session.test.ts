import { describe, expect, it } from 'vitest'
import { closeAsks, offersWorktreeRemoval } from '../src/renderer/lib/closeSession'

const worktree = { repoRoot: '/w/acme', path: '/w/_worktrees/acme-x', branch: 'x' }
const ask = { id: 'p', worktrees: { enabled: true, location: '', branchPrefix: '', baseRef: '', onClose: 'ask' as const } }
const keep = { id: 'k', worktrees: { ...ask.worktrees, onClose: 'keep' as const } }

describe('closing a session', () => {
  it('asks for a working session, or one in a worktree whose profile asks', () => {
    expect(closeAsks({ profileId: 'p' }, false, [ask])).toBe(false)
    expect(closeAsks({ profileId: 'p' }, true, [ask])).toBe(true)
    expect(closeAsks({ profileId: 'p', worktree }, false, [ask])).toBe(true)
    expect(closeAsks({ profileId: 'k', worktree }, false, [keep])).toBe(false)
    // A profile without settings asks (the default).
    expect(offersWorktreeRemoval({ profileId: null, worktree }, [])).toBe(true)
    expect(offersWorktreeRemoval({ profileId: 'k', worktree }, [keep])).toBe(false)
  })
})
