// Runs `wsl.exe` for the WSL helpers in core (listing distributions, reading one): no shell, the
// arguments as a list, the output decoded from whichever encoding `wsl.exe` wrote it in.
import { execFile, spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { WslRun, WslRunResult } from '@workhub/core'

/**
 * Decodes `wsl.exe` output. Its own messages and listings are UTF-16LE (often with a BOM) when it
 * runs from Windows, and UTF-8 with `WSL_UTF8=1` or when it runs from inside WSL; what a Linux
 * program in the distribution prints passes through as it was written (UTF-8). The BOM and stray
 * NULs are dropped.
 */
export function decodeWslOutput(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
  if (!utf16 && buf.length >= 2) {
    // ASCII text in UTF-16LE has a NUL after (nearly) every character.
    let oddNuls = 0
    for (let i = 1; i < buf.length; i += 2) if (buf[i] === 0) oddNuls++
    utf16 = oddNuls * 2 >= Math.floor(buf.length / 2)
  }
  return buf.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').replace(/\0/g, '')
}

export function wslRunner(options: { command?: string; timeoutMs?: number } = {}): WslRun {
  const command = options.command ?? 'wsl.exe'
  return (args) =>
    new Promise<WslRunResult>((resolve) => {
      execFile(command, args, { encoding: 'buffer', windowsHide: true, timeout: options.timeoutMs ?? 20_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
        resolve({ code, stdout: decodeWslOutput(stdout), stderr: decodeWslOutput(stderr) })
      })
    })
}

/** Runs `wsl.exe` with these arguments, `input` piped to its stdin (an archive to unpack inside a distribution). */
export type WslRunWithInput = (args: string[], input: Readable) => Promise<WslRunResult>

/**
 * A WslRunWithInput: no shell, the arguments as a list. Its output is kept up to 1 MiB; a run past
 * `timeoutMs` (10 minutes by default) is killed. A failure of `input` (a file that cannot be read)
 * ends the run with code -1 and the reason in `stderr`, never a hanging child.
 */
export function wslInputRunner(options: { command?: string; timeoutMs?: number } = {}): WslRunWithInput {
  const command = options.command ?? 'wsl.exe'
  const limit = 1024 * 1024
  return (args, input) =>
    new Promise<WslRunResult>((resolve) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      const out: Buffer[] = []
      const err: Buffer[] = []
      const keep = (into: Buffer[]) => (chunk: Buffer) => {
        if (into.reduce((n, b) => n + b.length, 0) < limit) into.push(chunk)
      }
      child.stdout.on('data', keep(out))
      child.stderr.on('data', keep(err))
      let failure: string | undefined
      let settled = false
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        input.unpipe(child.stdin)
        const stderr = decodeWslOutput(Buffer.concat(err))
        resolve({ code, stdout: decodeWslOutput(Buffer.concat(out)), stderr: failure ? `${failure}${stderr ? `\n${stderr}` : ''}` : stderr })
      }
      const timer = setTimeout(() => {
        failure = `timed out after ${options.timeoutMs ?? 600_000} ms`
        child.kill()
      }, options.timeoutMs ?? 600_000)
      // The child may exit before reading everything (tar failed): its stdin then errors with EPIPE.
      child.stdin.on('error', () => {})
      input.on('error', (e) => {
        failure = `could not read the input: ${e.message}`
        child.kill()
      })
      child.once('error', (e) => {
        failure = e.message
        finish(-1)
      })
      child.once('close', (code) => finish(failure ? (code === 0 || code === null ? -1 : code) : code))
      input.pipe(child.stdin)
    })
}
