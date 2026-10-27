/**
 * Copies one Claude Code session from one account's config folder to another's, so the other
 * account can resume it with the same session id (account failover). What Claude Code keeps per
 * session, relative to the config folder (`CLAUDE_CONFIG_DIR`):
 *
 * - `projects/<folder>/<id>.jsonl`: the transcript `--resume` / the SDK's `resume` reads.
 * - `projects/<folder>/<id>/`: its sidecars, `subagents/agent-<id>.jsonl` (+ `.meta.json`) and
 *   `tool-results/` (large tool outputs the transcript points to).
 * - `file-history/<id>/`: the file snapshots behind checkpoints and rewind.
 * - `tasks/<id>/`: the session's task list (newer Claude Code); `todos/<id>-agent-*.json` (older).
 *
 * `<folder>` is the session's folder name as the source account has it (Claude Code derives it
 * from the cwd), so the target gets the very same name. Nothing is ever moved or deleted, and an
 * existing file is never overwritten: a file already there with the same bytes is left alone, one
 * that is a prefix of the source (an older copy of this append-only transcript, from an earlier
 * failover the other way) only gets the missing tail appended, and any other difference is a
 * conflict. A conflict on the transcript stops the copy before anything is written; on a sidecar
 * that file is skipped and reported. Symbolic links are never followed.
 */
import { constants } from 'node:fs'
import { appendFile, copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

const SAFE_ID = /^[A-Za-z0-9_-]+$/

/** What to do with one file, given the source bytes and the target's (null: no target file). */
export type CopyAction = 'copy' | 'unchanged' | 'extend' | 'conflict'

export function copyAction(source: Uint8Array, target: Uint8Array | null): CopyAction {
  if (target === null) return 'copy'
  if (target.length > source.length) return 'conflict'
  for (let i = 0; i < target.length; i++) if (source[i] !== target[i]) return 'conflict'
  return target.length === source.length ? 'unchanged' : 'extend'
}

/** The per-session paths, relative to a config folder (see the header). */
export function claudeSessionPaths(sessionId: string, folder: string): { transcript: string; dirs: string[]; todoPrefix: string } {
  return {
    transcript: join('projects', folder, `${sessionId}.jsonl`),
    dirs: [join('projects', folder, sessionId), join('file-history', sessionId), join('tasks', sessionId)],
    todoPrefix: `${sessionId}-agent-`
  }
}

export interface SessionCopyResult {
  /** The project folder name the session lives under in both accounts. */
  folder: string
  /** Paths relative to the config folder. */
  copied: string[]
  extended: string[]
  unchanged: string[]
  /** Sidecar files skipped because the target holds a different file of that name. */
  conflicts: string[]
}

export class SessionCopyError extends Error {
  constructor(
    message: string,
    readonly code: 'not-found' | 'same-folder' | 'conflict' | 'invalid-id'
  ) {
    super(message)
    this.name = 'SessionCopyError'
  }
}

async function isFile(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null)
  return info?.isFile() ?? false
}

/** The source folder holding `<id>.jsonl`: the cwd-derived name first, then any project folder. */
export async function findSessionFolder(configDir: string, sessionId: string, cwd: string): Promise<string | null> {
  const projects = join(configDir, 'projects')
  const guess = cwd.replace(/[^A-Za-z0-9]/g, '-')
  if (await isFile(join(projects, guess, `${sessionId}.jsonl`))) return guess
  const folders = await readdir(projects).catch(() => [] as string[])
  for (const folder of folders.sort()) if (await isFile(join(projects, folder, `${sessionId}.jsonl`))) return folder
  return null
}

/** Regular files under `dir`, relative to `root`; links and anything else are skipped. */
async function filesUnder(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => [])
  const out: string[] = []
  for (const e of entries) {
    const rel = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await filesUnder(root, rel)))
    else if (e.isFile()) out.push(rel)
  }
  return out
}

const readOrNull = (path: string): Promise<Buffer | null> => readFile(path).catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : Promise.reject(err)))

/** A target path must stay inside the target folder (a defense against odd names). */
function inside(root: string, rel: string): string {
  const path = resolve(root, rel)
  if (!path.startsWith(resolve(root) + sep)) throw new SessionCopyError(`refusing to write outside ${root}`, 'invalid-id')
  return path
}

export interface CopyClaudeSessionInput {
  sessionId: string
  cwd: string
  sourceConfigDir: string
  targetConfigDir: string
}

export async function copyClaudeSession(input: CopyClaudeSessionInput): Promise<SessionCopyResult> {
  const { sessionId } = input
  if (!SAFE_ID.test(sessionId)) throw new SessionCopyError(`not a Claude session id: ${sessionId}`, 'invalid-id')
  const source = resolve(input.sourceConfigDir)
  const target = resolve(input.targetConfigDir)
  if (source === target) throw new SessionCopyError('both accounts use the same Claude folder', 'same-folder')
  const folder = await findSessionFolder(source, sessionId, input.cwd)
  if (!folder) throw new SessionCopyError(`the session's transcript is not in ${source}`, 'not-found')

  const paths = claudeSessionPaths(sessionId, folder)
  const todos = (await readdir(join(source, 'todos')).catch(() => [] as string[])).filter((f) => f.startsWith(paths.todoPrefix) && f.endsWith('.json')).map((f) => join('todos', f))
  const sidecars = [...(await Promise.all(paths.dirs.map((d) => filesUnder(source, d)))).flat(), ...todos]

  // Plan every file before writing any: a transcript conflict must leave the target untouched.
  const plan: { rel: string; action: CopyAction; bytes: Buffer; targetLength: number }[] = []
  for (const rel of [paths.transcript, ...sidecars]) {
    if (!(await isFile(join(source, rel)))) continue
    const bytes = await readFile(join(source, rel))
    const existing = await readOrNull(inside(target, rel))
    plan.push({ rel, action: copyAction(bytes, existing), bytes, targetLength: existing?.length ?? 0 })
  }
  if (plan[0]?.action === 'conflict') {
    throw new SessionCopyError(`the other account already has a different copy of this conversation (${paths.transcript}); nothing was copied`, 'conflict')
  }

  const result: SessionCopyResult = { folder, copied: [], extended: [], unchanged: [], conflicts: [] }
  for (const item of plan) {
    const to = inside(target, item.rel)
    if (item.action === 'conflict') result.conflicts.push(item.rel)
    else if (item.action === 'unchanged') result.unchanged.push(item.rel)
    else if (item.action === 'copy') {
      await mkdir(dirname(to), { recursive: true })
      // COPYFILE_EXCL: fails instead of overwriting a file that appeared since the plan.
      await copyFile(join(source, item.rel), to, constants.COPYFILE_EXCL)
      result.copied.push(item.rel)
    } else {
      // Re-check right before appending: only the bytes the plan saw may be there.
      const now = await readOrNull(to)
      if (!now || copyAction(item.bytes, now) !== 'extend' || now.length !== item.targetLength) {
        // The transcript is first in the plan, so nothing has been written when it fails here.
        if (item.rel === paths.transcript) throw new SessionCopyError('the other account changed its copy of this conversation meanwhile; nothing was copied', 'conflict')
        result.conflicts.push(item.rel)
        continue
      }
      await appendFile(to, item.bytes.subarray(now.length))
      result.extended.push(item.rel)
    }
  }
  return result
}
