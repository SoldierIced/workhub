import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useRef, useState } from 'react'

export function TerminalTab({ visible }: { visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const ptyId = useRef<number | null>(null)
  const [cwd, setCwd] = useState('')

  const spawn = useCallback(async (dir: string) => {
    const t = term.current
    if (!t) return
    if (ptyId.current !== null) window.hub.pty.kill(ptyId.current)
    t.reset()
    ptyId.current = await window.hub.pty.start(dir, t.cols, t.rows)
  }, [])

  useEffect(() => {
    const t = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13, cursorBlink: true })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current!)
    f.fit()
    term.current = t
    fit.current = f

    const offData = window.hub.pty.onData((id, data) => {
      if (id === ptyId.current) t.write(data)
    })
    const offExit = window.hub.pty.onExit((id, code) => {
      if (id === ptyId.current) t.write(`\r\n[process exited with code ${code}]\r\n`)
    })
    t.onData((d) => {
      if (ptyId.current !== null) window.hub.pty.write(ptyId.current, d)
    })
    t.onResize(({ cols, rows }) => {
      if (ptyId.current !== null) window.hub.pty.resize(ptyId.current, cols, rows)
    })
    const ro = new ResizeObserver(() => {
      if (host.current && host.current.offsetParent !== null) f.fit()
    })
    ro.observe(host.current!)

    void window.hub.getDefaultCwd().then((dir) => {
      setCwd(dir)
      void spawn(dir)
    })
    return () => {
      ro.disconnect()
      offData()
      offExit()
      if (ptyId.current !== null) window.hub.pty.kill(ptyId.current)
      t.dispose()
    }
  }, [spawn])

  useEffect(() => {
    if (visible) fit.current?.fit()
  }, [visible])

  const choose = async () => {
    const dir = await window.hub.pickFolder()
    if (dir) {
      setCwd(dir)
      void spawn(dir)
    }
  }

  return (
    <>
      <div className="bar">
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} aria-label="Terminal folder" />
        <button onClick={() => void choose()}>Choose...</button>
        <button onClick={() => void spawn(cwd)}>Restart here</button>
      </div>
      <div className="term" ref={host} />
    </>
  )
}
