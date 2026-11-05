import { describe, expect, it } from 'vitest'
import { commandChangePaths, toolChangePaths } from '../src/usecases/work-paths'

const HOME = '/Users/ana'
const BASE = '/Users/ana/acme'

describe('the folders a command changed a repository in', () => {
  it('ignores reads: cd, git log, git -C diff, gh pr list, searches', () => {
    expect(commandChangePaths('cd api && git log --oneline -5 && rg -n login src', BASE, HOME)).toEqual([])
    expect(commandChangePaths('git -C ~/acme/web diff; git -C web status', BASE, HOME)).toEqual([])
    expect(commandChangePaths('cd ~/acme/web && gh pr list --state all', BASE, HOME)).toEqual([])
    expect(commandChangePaths('git fetch -q origin && git checkout develop', BASE, HOME)).toEqual([])
  })

  it('counts git writes where they ran, following cd and -C', () => {
    expect(commandChangePaths('cd api && git add -A && git commit -m "fix" && git push -u origin HEAD', BASE, HOME)).toEqual([`${BASE}/api`, `${BASE}/api`])
    expect(commandChangePaths('git -C ~/acme/web checkout -b feat/x', BASE, HOME)).toEqual([`${BASE}/web`])
    expect(commandChangePaths('git -c user.name=x -C pay rebase origin/main', BASE, HOME)).toEqual([`${BASE}/pay`])
    expect(commandChangePaths('(cd pay && git switch -c fix/y)', BASE, HOME)).toEqual([`${BASE}/pay`])
    // The worktree it adds is where the work goes; its own edits and commits list it.
    expect(commandChangePaths('git worktree add ../pay-wt -b z', `${BASE}/pay`, HOME)).toEqual([])
  })

  it('counts pull requests it opened or merged, not one named with --repo', () => {
    expect(commandChangePaths('cd ~/acme/pay && gh pr create --title t --body-file /tmp/b.md', BASE, HOME)).toEqual([`${BASE}/pay`])
    expect(commandChangePaths('gh pr merge 12 --squash', `${BASE}/pay`, HOME)).toEqual([`${BASE}/pay`])
    expect(commandChangePaths('gh pr create -R acme/other --title t', BASE, HOME)).toEqual([])
  })

  it('skips here-document bodies: a PR body naming other repos is text', () => {
    const cmd = `cd ~/acme/pay && cat > /tmp/b.md <<'EOF'\nGoes with acme/web.\ncd ~/acme/web && git push\nEOF\ngh pr create --body-file /tmp/b.md`
    expect(commandChangePaths(cmd, BASE, HOME)).toEqual([`${BASE}/pay`])
  })

  it('counts an edited file folder and nothing for reads', () => {
    expect(toolChangePaths('Edit', { file_path: `${BASE}/api/src/a.ts` }, BASE, HOME)).toEqual([`${BASE}/api/src`])
    expect(toolChangePaths('Read', { file_path: `${BASE}/web/a.ts` }, BASE, HOME)).toEqual([])
    expect(toolChangePaths('Bash', { command: 'cd web && npm test' }, BASE, HOME)).toEqual([])
  })

  it('never splits quoted text', () => {
    expect(commandChangePaths('gh pr create --title "a | b" --repo acme/x', BASE, HOME)).toEqual([])
    expect(commandChangePaths('echo "run && git push"', BASE, HOME)).toEqual([])
    expect(commandChangePaths("git commit -m 'x; cd /elsewhere'", `${BASE}/pay`, HOME)).toEqual([`${BASE}/pay`])
  })

  it('sees git through env prefixes, global options and quoted -C paths', () => {
    expect(commandChangePaths('GIT_AUTHOR_DATE=now git commit -m x', `${BASE}/pay`, HOME)).toEqual([`${BASE}/pay`])
    expect(commandChangePaths('git --no-pager commit -m x', `${BASE}/pay`, HOME)).toEqual([`${BASE}/pay`])
    expect(commandChangePaths('git -C "/work/a b" commit -m x', BASE, HOME)).toEqual(['/work/a b'])
    expect(commandChangePaths('cd "/work/a b" && git push', BASE, HOME)).toEqual(['/work/a b'])
  })

  it('reads a here-string as one line and ends a cd with its subshell', () => {
    expect(commandChangePaths('cat <<< "x"\ncd /o && git commit -m y', BASE, HOME)).toEqual(['/o'])
    expect(commandChangePaths('(cd /o && git commit -m y); git push', `${BASE}/pay`, HOME)).toEqual(['/o', `${BASE}/pay`])
    expect(commandChangePaths('cat <<-EOF\n\tgit push\n\tEOF\ngit status', BASE, HOME)).toEqual([])
  })
})

