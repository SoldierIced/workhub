/**
 * Read-only access to OpenCode's SQLite database (`opencode.db`), through the SQLite that ships
 * with Node (`node:sqlite`): no native module to rebuild for Electron, the same on macOS, Linux
 * and Windows (Electron 45 runs Node 24; `node:sqlite` is available from Node 22.13).
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isFile } from '../shared/reader-utils'

/**
 * `$XDG_DATA_HOME/opencode/opencode.db`, else `~/.local/share/opencode/opencode.db`. Verified on
 * macOS. OpenCode builds its folders with xdg-basedir, which uses the same `~/.local/share`
 * default under the user profile on Windows; that case is not verified.
 */
export function defaultOpenCodeDbPath(): string {
  const dataHome = process.env['XDG_DATA_HOME']
  return join(dataHome || join(homedir(), '.local', 'share'), 'opencode', 'opencode.db')
}

export type Row = Record<string, unknown>

/** A read-only database that is opened for one piece of work and closed again. */
export async function withDatabase<T>(path: string, work: (query: (sql: string, ...params: SQLInputValue[]) => Row[]) => T): Promise<T | null> {
  if (!(await isFile(path))) return null
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 2000 })
    const open = db
    return work((sql, ...params) => open.prepare(sql).all(...params) as Row[])
  } catch {
    // A locked, corrupt or newer-schema database hides the data instead of breaking the session.
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}
