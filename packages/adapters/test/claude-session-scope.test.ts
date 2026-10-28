import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pullRequestNumbers } from '../src/shared/claude-tools'
import { commandActions, printedBranches, printedPullRequestUrls } from '../src/shared/shell-actions'
import { ClaudeTranscriptParser, SubagentParser } from '../src/transcript-claude/parser'

// A synthetic session (test/fixtures/claude-scope) in a folder of repositories whose current branch
// is someone else's work: it lists 10 open PRs, searches 20 tickets, reads a ticket, a file and a
// Slack channel, edits one ticket, commits and pushes a branch, opens one PR, and gets a background
// task's result and a Slack reply as user entries.
const lines = readFileSync(join(import.meta.dirname, 'fixtures', 'claude-scope', 'session.jsonl'), 'utf8').split('\n')
const HOME = '/Users/ana'

function parse(prefixes: string[] = ['ABC']) {
  const parser = new ClaudeTranscriptParser({ ticketPrefixes: prefixes, home: HOME })
  for (const line of lines) parser.ingest(line)
  return parser.snapshot()
}

describe("a Claude session's own work", () => {
  it('keeps the PR it created, never the ones a listing, a file, Slack or a task result printed', () => {
    const snap = parse()
    expect(snap.pullRequests).toEqual(['https://github.com/acme/web/pull/11'])
    expect(snap.pullRequestLinks).toEqual([{ source: 'acted', url: 'https://github.com/acme/web/pull/11' }])
  })

  it('keeps the ticket it edited, never the 20 of a search or the links of a ticket it read', () => {
    const snap = parse()
    expect(snap.linkedTicketKeys).toEqual(['ABC-305'])
    // Typed by the user; the reply names its work. Slack, the task result, the commit message and the PR body name none of the session's.
    expect(snap.ticketKeys).toEqual(['ABC-101'])
    expect(snap.replyTicketKeys).toEqual(['ABC-101', 'ABC-305'])
  })

  it('keeps the branch it created, committed on and pushed, not the folder current branch', () => {
    // The commit (`-q` prints nothing) is known by its folder; the branch, named again by the push, moves last.
    expect(parse().branches).toEqual([
      { folder: '/work/acme/web' },
      { name: 'feat/ABC-101-login', folder: '/work/acme/web', repo: 'acme/web', pushed: true }
    ])
  })

  it('takes PR URLs and numbers from what the user typed, and slash command arguments, but not reminders', () => {
    const parser = new ClaudeTranscriptParser({ ticketPrefixes: ['ABC'], home: HOME })
    const prompt = (content: string) => parser.ingest(JSON.stringify({ type: 'user', message: { content } }))
    prompt('Review https://github.com/acme/web/pull/4 and web#5, then PR 6 <system-reminder>ABC-1 and https://github.com/acme/web/pull/9</system-reminder>')
    prompt('<command-name>/review</command-name><command-message>review</command-message><command-args>ABC-2</command-args>')
    const snap = parser.snapshot()
    expect(snap.pullRequestLinks).toEqual([
      { source: 'user', url: 'https://github.com/acme/web/pull/4' },
      { source: 'user', number: 5, repo: 'web' },
      { source: 'user', number: 6 }
    ])
    expect(snap.ticketKeys).toEqual(['ABC-2'])
  })

  it('leaves out a final reply that lists many tickets or PRs: a listing, not its work', () => {
    const parser = new ClaudeTranscriptParser({ ticketPrefixes: ['ABC'], home: HOME })
    const reply = (text: string) => parser.ingest(JSON.stringify({ type: 'assistant', message: { id: `m${text.length}`, content: [{ type: 'text', text }] } }))
    reply('Your backlog: ABC-1, ABC-2, ABC-3, ABC-4 and https://github.com/acme/web/pull/1 https://github.com/acme/web/pull/2 https://github.com/acme/web/pull/3 https://github.com/acme/web/pull/4')
    parser.ingest(JSON.stringify({ type: 'user', message: { content: 'thanks' } }))
    expect(parser.snapshot().replyTicketKeys).toBeUndefined()
    expect(parser.snapshot().pullRequestLinks).toBeUndefined()
    reply('Fixed ABC-7.')
    expect(parser.snapshot().replyTicketKeys).toEqual(['ABC-7'])
  })

  it("counts what a subagent changed, not what it only read", () => {
    const sub = new SubagentParser(Date.now, HOME, ['ABC'])
    const call = (id: string, command: string, result: string) => {
      sub.ingest(JSON.stringify({ type: 'assistant', cwd: '/work/acme/web', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }))
      sub.ingest(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: result }] } }))
    }
    call('t1', 'gh pr view 12 -R acme/web --json body', '{"body":"x"}')
    call('t2', 'gh pr comment 13 -R acme/web --body "done"', 'https://github.com/acme/web/pull/13#issuecomment-1')
    call('t3', 'gh pr comment 14 -R acme/web --body "x"', 'failed')
    expect(sub.links.prs).toEqual([
      { source: 'acted', url: 'https://github.com/acme/web/pull/13' },
      { source: 'acted', url: 'https://github.com/acme/web/pull/14' }
    ])
  })

  it('counts nothing of a failed command', () => {
    const parser = new ClaudeTranscriptParser({ home: HOME })
    parser.ingest(JSON.stringify({ type: 'assistant', cwd: '/work/web', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'git push origin feat/a' } }] } }))
    parser.ingest(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'rejected', is_error: true }] } }))
    expect(parser.snapshot().branches).toBeUndefined()
  })
})

describe('shell commands on PRs and branches', () => {
  const run = (command: string) => commandActions(command, '/work/acme', HOME)

  it('reads the PR a gh command acts on, by URL, by number with its repository or with the folder it ran in', () => {
    expect(run('gh pr view 348 -R acme/web --json body').prs).toEqual([{ changes: false, url: 'https://github.com/acme/web/pull/348' }])
    expect(run('cd web && gh pr merge --squash https://github.com/Acme/Web/pull/9').prs).toEqual([{ changes: true, url: 'https://github.com/acme/web/pull/9' }])
    expect(run('cd web && gh pr review 12 --approve -b "ok"').prs).toEqual([{ changes: true, number: 12, folder: '/work/acme/web' }])
    expect(run('gh api repos/acme/web/pulls/90/comments --jq ".[].body"').prs).toEqual([{ changes: false, url: 'https://github.com/acme/web/pull/90' }])
    expect(run('gh api -X POST repos/acme/web/pulls/90/comments/1/replies -f body=ok').prs).toEqual([{ changes: true, url: 'https://github.com/acme/web/pull/90' }])
  })

  it('reads no PR of a listing, a variable or a loop', () => {
    for (const command of ['gh pr list -R acme/web --json url', 'gh search prs --owner acme', 'for n in 1 2; do gh pr view $n -R acme/$r; done', 'gh api repos/acme/$r/pulls/$n']) {
      const acts = run(command)
      expect(acts.prs).toEqual([])
      expect(acts.prOutput).toBe('none')
    }
    // `create` names its PR only in its output; a listing in the same command would mix others in.
    expect(run('gh pr create --fill').prOutput).toBe('any')
    expect(run('gh pr create --fill && gh pr list').prOutput).toBe('none')
  })

  it('reads branches created, checked out, committed on and pushed, never quoted text or files', () => {
    expect(run('git -C web switch -c feat/a origin/main 2>&1 && git -C web commit -qm "git push origin feat/fake"').branches).toEqual([
      { name: 'feat/a', folder: '/work/acme/web' },
      { folder: '/work/acme/web' }
    ])
    expect(run('cd api && git checkout fix/b && git push -u origin fix/b:fix/b').branches).toEqual([
      { name: 'fix/b', folder: '/work/acme/api' },
      { name: 'fix/b', folder: '/work/acme/api', pushed: true }
    ])
    expect(run('git worktree add ../wt -b feat/c origin/develop').branches).toEqual([{ name: 'feat/c', folder: '/work/wt' }])
    for (const command of ['git checkout -- src/a.ts', 'git checkout origin/develop', 'git checkout README.md', 'git push origin --delete feat/old', 'git log feat/x', 'echo "git push origin feat/y"']) {
      expect(run(command).branches).toEqual([])
    }
    expect(run('git commit -F - <<\'EOF\'\ngit checkout -b feat/fake\nEOF').branches).toEqual([{ folder: '/work/acme' }])
  })

  it('reads the branch git printed for a commit or a push, and the repository pushed to', () => {
    const out = '[feat/a 1a2b3c4] feat: x\n 2 files changed\nTo https://github.com/Acme/Web.git\n   1a2b3c4..5d6e7f8  feat/a -> feat/a\n'
    expect(printedBranches(out)).toEqual([
      { name: 'feat/a', pushed: false },
      { name: 'feat/a', pushed: true, repo: 'acme/web' }
    ])
  })

  it('reads the PR URLs gh printed for the PR it acted on, not ones inside a body', () => {
    const out = 'title: x\nbody: depends on https://github.com/acme/web/pull/1 first\nView this pull request on GitHub: https://github.com/acme/web/pull/2\nhttps://github.com/acme/web/pull/3\n{"url":"https://github.com/acme/web/pull/4"}'
    expect(printedPullRequestUrls(out)).toEqual(['https://github.com/acme/web/pull/2', 'https://github.com/acme/web/pull/3', 'https://github.com/acme/web/pull/4'])
  })

  it('reads PR numbers a prompt names', () => {
    expect(pullRequestNumbers('see PR #12, el PR 13, acme/web#14 and api#15; not issue 16 or https://github.com/acme/web/pull/17')).toEqual([
      { number: 14, repo: 'acme/web' },
      { number: 15, repo: 'api' },
      { number: 12 },
      { number: 13 }
    ])
  })
})
