import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { attachOutput } from '../../store'
import { readPrefs, usePrefs } from '../../lib/prefs'
import { findTerminalTheme, terminalFontStack, xtermTheme } from '../../lib/terminalThemes'

/** xterm colors: the chosen terminal theme (Settings → Appearance), else the app theme's tokens. */
function terminalTheme(): ITheme {
  const chosen = findTerminalTheme(readPrefs().terminalTheme)
  if (chosen) return xtermTheme(chosen)
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return { background: v('--wh-bg'), foreground: v('--wh-text'), cursor: v('--wh-accent'), selectionBackground: v('--wh-accent-soft') }
}

function terminalFont(): { fontFamily: string; fontSize: number } {
  const { terminalFontFamily, terminalFontSize } = readPrefs()
  return { fontFamily: terminalFontStack(terminalFontFamily, getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim()), fontSize: terminalFontSize }
}

/** One terminal channel of a session (`<id>:console` or `<id>:shell`). */
export function TerminalPane({ channel, visible, theme, label }: { channel: string; visible: boolean; theme: 'light' | 'dark'; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const fit = useRef<FitAddon | null>(null)
  const term = useRef<Terminal | null>(null)
  const { terminalTheme: themeName, themeApp, terminalFontFamily, terminalFontSize } = usePrefs()

  useEffect(() => {
    const t = new Terminal({ ...terminalFont(), cursorBlink: true, theme: terminalTheme() })
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
    // After the app has applied the new tokens to <html> (its effect runs after this one).
    const frame = requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = terminalTheme()
    })
    return () => cancelAnimationFrame(frame)
  }, [theme, themeName, themeApp])

  useEffect(() => {
    const t = term.current
    if (!t) return
    Object.assign(t.options, terminalFont())
    if (host.current?.offsetParent) fit.current?.fit()
  }, [terminalFontFamily, terminalFontSize])

  useEffect(() => {
    if (!visible) return
    fit.current?.fit()
    term.current?.focus()
  }, [visible])

  return <div className="xterm-host min-h-0 min-w-0 flex-1" ref={host} role="region" aria-label={label} data-testid={`terminal-${channel.split(':')[1]}`} />
}
