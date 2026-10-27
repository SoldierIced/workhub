import * as nodePty from 'node-pty'

export class PtyManager {
  private ptys = new Map<number, nodePty.IPty>()
  private nextId = 1

  constructor(
    private onData: (id: number, data: string) => void,
    private onExit: (id: number, code: number) => void
  ) {}

  start(cwd: string, cols: number, rows: number): number {
    const shell = process.env['SHELL'] ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
    // `-l` = login shell on POSIX; Windows shells have no such flag.
    const args = process.platform === 'win32' ? [] : ['-l']
    const p = nodePty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: process.env as Record<string, string>
    })
    const id = this.nextId++
    this.ptys.set(id, p)
    p.onData((d) => this.onData(id, d))
    p.onExit(({ exitCode }) => {
      this.ptys.delete(id)
      this.onExit(id, exitCode)
    })
    return id
  }

  write(id: number, data: string): void {
    this.ptys.get(id)?.write(data)
  }

  resize(id: number, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.ptys.get(id)?.resize(cols, rows)
  }

  kill(id: number): void {
    this.ptys.get(id)?.kill()
    this.ptys.delete(id)
  }

  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
