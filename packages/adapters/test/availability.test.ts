import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS } from '@workhub/core'
import { agentAvailability, findExecutable } from '../src/agent-acp'

const dirs: string[] = []
async function folderWith(files: Record<string, number>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wh-bin-'))
  dirs.push(dir)
  for (const [name, mode] of Object.entries(files)) {
    await writeFile(join(dir, name), '#!/bin/sh\n')
    await chmod(join(dir, name), mode)
  }
  return dir
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('findExecutable', () => {
  it('finds a command on PATH and ignores files that are not executable', async () => {
    // Windows decides by extension, not by mode bits: a runnable file needs one from PATHEXT.
    const win = process.platform === 'win32'
    const bin = await folderWith(win ? { 'wh-agent.cmd': 0o644, 'wh-plain': 0o644 } : { 'wh-agent': 0o755, 'wh-plain': 0o644 })
    const found = await findExecutable('wh-agent', { path: bin, pathExt: '.EXE;.CMD' })
    expect(found?.toLowerCase()).toBe(join(bin, win ? 'wh-agent.cmd' : 'wh-agent').toLowerCase())
    expect(await findExecutable('wh-plain', { path: bin, pathExt: '.EXE;.CMD' })).toBeNull()
    expect(await findExecutable('wh-missing', { path: bin, pathExt: '.EXE;.CMD' })).toBeNull()
    expect(await findExecutable('', { path: bin })).toBeNull()
  })

  it('searches the extra folders first and accepts a full path', async () => {
    const [first, second] = [await folderWith({ 'wh-agent': 0o755 }), await folderWith({ 'wh-agent': 0o755 })]
    expect(await findExecutable('wh-agent', { path: second, extraPath: [first], platform: 'linux' })).toBe(join(first, 'wh-agent'))
    expect(await findExecutable(join(second, 'wh-agent'), { path: '', platform: 'linux' })).toBe(join(second, 'wh-agent'))
    expect(await findExecutable('wh-agent', { path: ['', second].join(delimiter), platform: 'linux' })).toBe(join(second, 'wh-agent'))
  })

  it('tries the PATHEXT extensions on Windows, where the executable bit does not exist', async () => {
    const bin = await folderWith({ 'wh-agent.cmd': 0o644 })
    expect(await findExecutable('wh-agent', { path: bin, platform: 'win32', pathExt: '.EXE;.CMD' })).toBe(join(bin, 'wh-agent.cmd'))
    expect(await findExecutable('wh-agent.cmd', { path: bin, platform: 'win32', pathExt: '.EXE;.CMD' })).toBe(join(bin, 'wh-agent.cmd'))
    // Upper-case lookup needs a case-insensitive file system (Windows, default macOS), not Linux.
    if (process.platform !== 'linux') expect(await findExecutable('WH-AGENT.CMD', { path: bin, platform: 'win32', pathExt: '.exe;.cmd' })).toBe(join(bin, 'WH-AGENT.CMD'))
  })

  it('does not accept an exact name whose extension is not in PATHEXT on Windows', async () => {
    const bin = await folderWith({ 'wh-tool.txt': 0o644 })
    expect(await findExecutable('wh-tool.txt', { path: bin, platform: 'win32', pathExt: '.EXE;.CMD' })).toBeNull()
  })
})

describe('agentAvailability', () => {
  it('reports each agent by its command, and the shell as always available', async () => {
    const bin = await folderWith({ 'kiro-cli': 0o755, npx: 0o755 })
    const result = await agentAvailability(BUILTIN_AGENTS, { path: bin, platform: 'linux' })
    expect(result).toEqual({ claude: false, 'claude-acp': false, kiro: true, opencode: false, codex: true, gemini: false, shell: true })
  })
})
