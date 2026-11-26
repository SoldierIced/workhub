---
name: workhub-review
description: Ask the user to review your local changes in Workhub's Review changes window before a commit, push or pull request; their line comments come back to you as one message. Trigger: finished a change, "show me the changes", "let me review it", "before you commit", "before the PR", "mostrame los cambios", "dejame revisarlo", "antes de commitear", "antes del PR".
---

# Workhub review

Workhub can show the user your local changes in its **Review changes** window: a diff per repo
where they comment on lines and send every comment to you as one chat message. Use it to get the
user's eyes on a change before it leaves the machine. Full reference: "Review changes: review it
yourself" in `docs/user-guide/review-before-pr.md` of the Workhub repository.

## When to use

- You finished a unit of work and the user will commit, push or open a pull request next.
- The user asks to see, check or review the changes.
- You are about to commit or push for the user: open the review first and wait.

Do not open it after every small edit, for changes the user already reviewed and that did not
change since, or in a reviewer session (it cannot receive comments).

## Open the review

When the `workhub` MCP tools are available, call `review_open` with the repos you changed:

```json
{ "repos": [{ "path": "/abs/path/to/repo", "base": "origin/main" }] }
```

Without them, call the endpoint. The session environment has `WORKHUB_SESSION`,
`WORKHUB_SESSION_TOKEN` (sent as `X-Workhub-Token`, every call needs it) and either
`WORKHUB_SOCKET` (macOS, Linux) or `WORKHUB_URL` and `WORKHUB_TOKEN` (Windows). With none of them
you are not in a Workhub session: say so and stop. Never print or pass on the token.

```sh
W() {
  local t=(-H "X-Workhub-Token: $WORKHUB_SESSION_TOKEN")
  if [ -n "$WORKHUB_URL" ]; then
    local a=() x; for x in "$@"; do a+=("${x/http:\/\/workhub/$WORKHUB_URL}"); done
    curl -s -H "Authorization: Bearer $WORKHUB_TOKEN" "${t[@]}" "${a[@]}"
  else curl -s --unix-socket "$WORKHUB_SOCKET" "${t[@]}" "$@"; fi
}
W -X POST "http://workhub/v1/sessions/$WORKHUB_SESSION/review" -H 'content-type: application/json' \
  -d '{"repos":[{"path":"/abs/path/to/repo","base":"origin/main"}]}'
```

- `repos` lists only the repos you changed, by absolute path. Each must be inside this session's
  folder, its worktree or one of its profile's folders (by real path), or be a `git worktree add`
  worktree of a repository there (local sessions only; a session that runs in a linked worktree also
  reaches its repository's main folder and other worktrees); others are refused with a 400. A plain
  clone in a temporary folder outside them cannot be reviewed here: say so.
- `base` is what to compare with: the branch the work started from (`origin/main`, a release
  branch) or a commit. Leave it out to let Workhub pick.
- An open window reloads with the new repos and base.

## After opening

1. Tell the user the review is open in Workhub and that you are waiting for their comments. Stop:
   do not commit, push or open a pull request while it is open.
2. Their comments arrive as one message, by file and line. Treat each as a change request: fix it,
   or explain why not, and answer them one by one.
3. If you changed anything, open the review again for another round.
4. **Looks good** (or the user saying so) ends it. Then do only what the user asked: committing and
   pushing still need their word.
