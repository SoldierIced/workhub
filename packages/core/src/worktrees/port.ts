/** What a worktree holds that removing it would lose. */
export interface WorktreeStatus {
  /** Uncommitted changes, staged or not, or untracked files. */
  dirty: boolean
  /** Commits on its branch that no remote branch has. */
  unpushed: number
  branch: string
}

/** A worktree Workhub created for a session, kept with the session so it can be offered for removal. */
export interface SessionWorktree {
  /** The main repository's root. */
  repoRoot: string
  /** The worktree's root. */
  path: string
  branch: string
}

/** Creates and removes git worktrees for sessions. Repository hooks run, as in any checkout the user makes. */
export interface Worktrees {
  /** The root of the main repository holding `path` (a linked worktree resolves to its main repository); null outside a repository. */
  repoRootOf(path: string): Promise<string | null>
  /**
   * Adds a worktree at `path` on `branch`: an existing local branch is checked out, else the
   * branch is created from `base` (empty: the repository's default branch). A `path` inside the
   * repository is added to the repository's local exclude file.
   */
  create(repoRoot: string, opts: { path: string; branch: string; base?: string }): Promise<void>
  status(path: string): Promise<WorktreeStatus>
  /** Removes the worktree (its branch stays). Without `force`, git refuses one with changes. */
  remove(repoRoot: string, path: string, opts: { force: boolean }): Promise<void>
}
