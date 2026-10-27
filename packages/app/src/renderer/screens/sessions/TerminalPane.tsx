import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { attachOutput } from '../../store'

/** xterm colors from the active theme's tokens. */
function terminalTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return { background: v('--wh-bg'), foreground: v('--wh-text'), cursor: v('--wh-accent'), selectionBackground: v('--wh-accent-soft') }
}

/** One terminal channel of a session (`<id>:console` or `<id>:shell`). */
export function TerminalPane({ channel, visible, theme, label }: { channel: string; visible: boolean; theme: 'light' | 'dark'; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const fit = useRef<FitAddon | null>(null)
  const term = useRef<Terminal | null>(null)

  useEffect(() => {
    const t = new Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace', fontSize: 13, cursorBlink: true, theme: terminalTheme() })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current!)
    fit.current = f
    term.current = t
    const detach = attachOutput(channel, (d) => t.write(d))
    t.onData((d) => window.hub.sessions.write(channel, d))
    t.onResize(({ cols, rows }) => window.hub.sessions.resize(channel, cols, rows))
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetParent) f.fit()
    })
    ro.observe(host.current!)
    return () => {
      ro.disconnect()
      detach()
      t.dispose()
      term.current = null
    }
  }, [channel])

  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme()
  }, [theme])

  useEffect(() => {
    if (!visible) return
    fit.current?.fit()
    term.current?.focus()
  }, [visible])

  return <div className="xterm-host min-h-0 min-w-0 flex-1" ref={host} role="region" aria-label={label} data-testid={`terminal-${channel.split(':')[1]}`} />
}
