// File system checks over the host: whether a path exists and what it is, where the folders live.
import { access, realpath, stat } from 'node:fs/promises'
import { z } from 'zod'
import type { HostClient } from './client'
import type { HostHandlers } from './server'
import { parseParams, parseResult } from './proxies/shared'

/** What `stat` tells of a path on a host. */
export interface HostFileInfo {
  size: number
  mtimeMs: number
  mode: number
  isFile: boolean
  isDirectory: boolean
}

/** The file system checks the app runs on a host's folders. */
export interface HostFileChecks {
  /** Whether a path exists on the host; false when the host cannot be reached. */
  exists(path: string): Promise<boolean>
  /** A path's size, times and kind on the host; null when it cannot be read (missing, no access, no host). */
  stat(path: string): Promise<HostFileInfo | null>
  /** The path with its symlinks resolved on the host; null when it does not exist (or no host). */
  realpath(path: string): Promise<string | null>
}

const pathParams = z.object({ path: z.string().min(1) })
const fileInfo = z.object({ size: z.number(), mtimeMs: z.number(), mode: z.number(), isFile: z.boolean(), isDirectory: z.boolean() })

/** `stat` on the disk of the process that runs it. */
export async function statPath(path: string): Promise<HostFileInfo | null> {
  const info = await stat(path).catch(() => null)
  return info && { size: info.size, mtimeMs: info.mtimeMs, mode: info.mode, isFile: info.isFile(), isDirectory: info.isDirectory() }
}

/** `realpath` on the disk of the process that runs it; null when the path does not exist. */
export async function realPathOrNull(path: string): Promise<string | null> {
  return realpath(path).catch(() => null)
}

/** Host side: `fs.exists`, `fs.stat` and `fs.realpath` on the host's disk. */
export function fsHandlers(): HostHandlers {
  return {
    'fs.exists': async (params) => {
      const { path } = parseParams(pathParams, params, 'fs.exists')
      return access(path).then(
        () => true,
        () => false
      )
    },
    'fs.stat': async (params) => statPath(parseParams(pathParams, params, 'fs.stat').path),
    'fs.realpath': async (params) => realPathOrNull(parseParams(pathParams, params, 'fs.realpath').path)
  }
}

/** App side: the same checks on the host. Like the local ones they never reject. */
export function remoteFolders(client: HostClient): HostFileChecks {
  return {
    exists: async (path) => {
      try {
        return parseResult(z.boolean(), await client.request('fs.exists', { path }), 'fs.exists')
      } catch {
        return false
      }
    },
    stat: async (path) => {
      try {
        return parseResult(fileInfo.nullable(), await client.request('fs.stat', { path }), 'fs.stat')
      } catch {
        return null
      }
    },
    // A host without it (an older build) resolves nothing: a check that needs it refuses.
    realpath: async (path) => {
      try {
        return parseResult(z.string().nullable(), await client.request('fs.realpath', { path }), 'fs.realpath')
      } catch {
        return null
      }
    }
  }
}
