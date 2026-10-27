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

/**
 * One terminal channel of a session (`<id>:console` or `<id>:shell`). The terminal fills its
 * container: it is fitted on mount, when it shows, when its container or the window resizes and
 * once the fonts load, and every fit tells main the size, so the agent's PTY (which may start
 * after the terminal mounted, or start again after a hand-over) always draws at that size.
 */
export function TerminalPane({ channel, visible, theme, label }: { channel: string; visible: boolean; theme: 'light' | 'dark'; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const refit = useRef<() => void>(() => undefined)
  const term = useRef<Terminal | null>(null)

  useEffect(() => {
    const t = new Terminal({ fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace', fontSize: 13, cursorBlink: true, theme: terminalTheme() })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current!)
    term.current = t
    const detach = attachOutput(channel, (d) => t.write(d))
    t.onData((d) => window.hub.sessions.write(channel, d))
    let sent = ''
    let frame = 0
    const fit = () => {
      // A hidden terminal measures 0 x 0: it is fitted when it shows.
      const el = host.current
      if (!el || !el.offsetParent || el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        f.fit()
      } catch {
        return
      }
      const size = `${t.cols}x${t.rows}`
      if (size === sent) return
      sent = size
      window.hub.sessions.resize(channel, t.cols, t.rows)
    }
    // Coalesced to one fit per frame (a window drag fires many).
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    }
    refit.current = () => {
      // The PTY may have started again since the last fit: send the size even if it did not change.
      sent = ''
      schedule()
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(host.current!)
    window.addEventListener('resize', schedule)
    // The cell size changes once the monospace font has loaded.
    void document.fonts?.ready.then(schedule)
    document.fonts?.addEventListener?.('loadingdone', schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      document.fonts?.removeEventListener?.('loadingdone', schedule)
      detach()
      t.dispose()
      term.current = null
      refit.current = () => undefined
    }
  }, [channel])

  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme()
  }, [theme])

  useEffect(() => {
    if (!visible) return
    refit.current()
    term.current?.focus()
  }, [visible])

  return <div className="xterm-host h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden" ref={host} role="region" aria-label={label} data-testid={`terminal-${channel.split(':')[1]}`} />
}
