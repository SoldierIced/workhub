import { Check, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Button, Input, Select, Switch } from '../components/atoms'
import { useI18n } from '../i18n/I18nProvider'
import { cn } from '../lib/cn'
import { BASE_TEXT_SIZE, SIZE_RANGES, setPrefs, usePrefs, type Prefs } from '../lib/prefs'
import { findTerminalTheme, isDarkTheme, searchTerminalThemes, TERMINAL_FONT_FAMILIES, TERMINAL_THEMES, terminalFontStack, type TerminalThemeDef } from '../lib/terminalThemes'
import { SettingRow, SettingsGroup } from './settings/SettingsLayout'

/** Settings → Appearance: light or dark, the terminal color scheme (optionally for the whole app), fonts and text sizes. */
export function AppearanceSettings() {
  const { t } = useI18n()
  const prefs = usePrefs()
  const current = findTerminalTheme(prefs.terminalTheme)
  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={t('appearance.base')} help={t('help.appearance.base')} footnote={t('settings.themeHint')}>
        <SettingRow label={t('settings.theme')} hint={prefs.themeApp && current ? t('appearance.baseOverridden') : undefined}>
          <Select
            aria-label={t('settings.theme')}
            value={prefs.theme}
            disabled={prefs.themeApp && Boolean(current)}
            onChange={(v) => setPrefs({ theme: v as Prefs['theme'] })}
            options={[
              { value: 'system', label: t('settings.system') },
              { value: 'light', label: t('settings.light') },
              { value: 'dark', label: t('settings.dark') }
            ]}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t('appearance.themeGroup')} help={t('help.appearance.theme')} footnote={t('appearance.attribution')}>
        <div className="flex flex-col gap-3 py-3">
          <ThemePreview theme={current} fontFamily={prefs.terminalFontFamily} fontSize={prefs.terminalFontSize} />
          <ThemePicker value={prefs.terminalTheme} onChange={(name) => setPrefs({ terminalTheme: name })} />
        </div>
        <SettingRow label={t('appearance.themeApp')} hint={current ? t('appearance.themeAppHint') : t('appearance.themeAppNeedsTheme')}>
          <div className="flex justify-end">
            <Switch checked={prefs.themeApp} disabled={!current} onChange={(on) => setPrefs({ themeApp: on })} aria-label={t('appearance.themeApp')} />
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={t('appearance.terminalFont')} help={t('help.appearance.terminalFont')}>
        <SettingRow label={t('appearance.fontFamily')}>
          <Select
            aria-label={t('appearance.fontFamily')}
            value={prefs.terminalFontFamily}
            onChange={(v) => setPrefs({ terminalFontFamily: v })}
            options={[
              ...TERMINAL_FONT_FAMILIES.map((f) => ({ value: f, label: f || t('appearance.fontDefault') })),
              // A family imported from Workhub 1 that is not in the list stays selectable.
              ...(prefs.terminalFontFamily && !(TERMINAL_FONT_FAMILIES as readonly string[]).includes(prefs.terminalFontFamily)
                ? [{ value: prefs.terminalFontFamily, label: prefs.terminalFontFamily }]
                : [])
            ]}
          />
        </SettingRow>
        <SizeRow label={t('appearance.fontSize')} prefKey="terminalFontSize" value={prefs.terminalFontSize} fallback={13} />
      </SettingsGroup>

      <SettingsGroup title={t('appearance.textGroup')} help={t('help.appearance.text')}>
        <SizeRow label={t('appearance.textSize')} hint={t('appearance.textSizeHint')} prefKey="textSize" value={prefs.textSize} fallback={BASE_TEXT_SIZE} />
        <SizeRow label={t('appearance.chatSize')} hint={t('appearance.chatSizeHint')} prefKey="chatFontSize" value={prefs.chatFontSize} fallback={BASE_TEXT_SIZE} />
      </SettingsGroup>
    </div>
  )
}

function SizeRow({ label, hint, prefKey, value, fallback }: { label: string; hint?: string; prefKey: keyof typeof SIZE_RANGES; value: number; fallback: number }) {
  const { t } = useI18n()
  const [min, max] = SIZE_RANGES[prefKey]
  return (
    <SettingRow label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          aria-label={label}
          aria-valuetext={t('appearance.px', { size: value })}
          onChange={(e) => setPrefs({ [prefKey]: Number(e.target.value) })}
          className="min-w-0 flex-1 accent-[var(--wh-accent)]"
        />
        <span className="w-11 text-right text-sm text-muted tabular-nums">{t('appearance.px', { size: value })}</span>
        <Button size="sm" variant="ghost" disabled={value === fallback} onClick={() => setPrefs({ [prefKey]: fallback })} aria-label={t('appearance.resetNamed', { name: label })}>
          {t('appearance.reset')}
        </Button>
      </div>
    </SettingRow>
  )
}

/** The chosen scheme as a small terminal: prompt, a success and a failure line, and its palette. */
function ThemePreview({ theme, fontFamily, fontSize }: { theme: TerminalThemeDef | undefined; fontFamily: string; fontSize: number }) {
  const { t } = useI18n()
  const mono = terminalFontStack(fontFamily, 'var(--font-mono)')
  const p = theme?.palette
  const fg = theme?.foreground ?? 'var(--wh-text)'
  return (
    <div
      className="rounded-lg border border-border p-3"
      style={{ background: theme?.background ?? 'var(--wh-bg)', color: fg }}
      data-testid="theme-preview"
      aria-label={t('appearance.preview', { name: theme?.name ?? t('appearance.default') })}
      role="img"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="min-w-0 flex-1 truncate">{theme?.name ?? t('appearance.default')}</span>
        <span className="text-xs font-normal opacity-70">{theme ? (isDarkTheme(theme) ? t('settings.dark') : t('settings.light')) : ''}</span>
      </div>
      <div style={{ fontFamily: mono, fontSize: Math.min(fontSize, 18) }} className="leading-normal">
        <div>
          <span style={{ color: p?.[4] ?? 'var(--wh-info)' }}>~/projects/app </span>
          <span style={{ color: p?.[5] ?? 'var(--wh-accent-2)' }}>main</span> $ claude
        </div>
        <div>
          <span style={{ color: p?.[2] ?? 'var(--wh-success)' }}>✓ {t('appearance.previewPassed')}</span>
          {'  '}
          <span style={{ color: p?.[3] ?? 'var(--wh-warning)' }}>! {t('appearance.previewWarning')}</span>
          {'  '}
          <span style={{ color: p?.[1] ?? 'var(--wh-danger)' }}>✗ {t('appearance.previewFailed')}</span>
        </div>
      </div>
      {p && (
        <div className="mt-2 flex gap-1" aria-hidden>
          {p.slice(0, 8).map((c, i) => (
            <span key={i} className="h-2.5 w-5 rounded-sm" style={{ background: c }} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Searchable list of every bundled scheme, plus Workhub's own colors; arrow keys move the selection. */
function ThemePicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const matches = useMemo(() => searchTerminalThemes(query), [query])
  const names = useMemo(() => (query.trim() ? matches.map((m) => m.name) : ['', ...matches.map((m) => m.name)]), [matches, query])

  // Keeps the chosen theme in view inside the list only (scrollIntoView would also scroll the page).
  const reveal = (center: boolean) => {
    const box = list.current
    const row = box?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!box || !row) return
    const top = row.offsetTop // the list is the offset parent (relative)
    if (center) box.scrollTop = top - box.clientHeight / 2 + row.offsetHeight / 2
    else if (top < box.scrollTop) box.scrollTop = top
    else if (top + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top + row.offsetHeight - box.clientHeight
  }
  useEffect(() => reveal(false), [query])
  useEffect(() => reveal(true), [])

  const move = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    if (!names.length) return
    const at = names.indexOf(value)
    const next = e.key === 'ArrowDown' ? Math.min(names.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)
    onChange(names[next]!)
    requestAnimationFrame(() => reveal(false))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={move}
          placeholder={t('appearance.search', { count: TERMINAL_THEMES.length })}
          aria-label={t('appearance.search', { count: TERMINAL_THEMES.length })}
          aria-controls="terminal-theme-list"
          className="pl-8"
        />
      </div>
      <div
        ref={list}
        id="terminal-theme-list"
        role="listbox"
        aria-label={t('appearance.themeGroup')}
        tabIndex={0}
        onKeyDown={move}
        className="relative h-64 overflow-y-auto rounded-md border border-border bg-bg p-1"
      >
        {names.length === 0 && <p className="px-2 py-3 text-sm text-subtle">{t('appearance.noMatch', { query })}</p>}
        {names.map((name) => (
          <ThemeOption key={name || 'workhub'} theme={findTerminalTheme(name)} selected={name === value} onSelect={() => onChange(name)} />
        ))}
      </div>
    </div>
  )
}

function ThemeOption({ theme, selected, onSelect }: { theme: TerminalThemeDef | undefined; selected: boolean; onSelect: () => void }) {
  const { t } = useI18n()
  return (
    <div
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-base transition-colors hover:bg-surface-hover',
        selected && 'bg-accent-soft font-medium text-accent hover:bg-accent-soft'
      )}
    >
      <Check className={cn('size-3.5 shrink-0', !selected && 'invisible')} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{theme?.name ?? t('appearance.default')}</span>
      {theme ? (
        <span className="flex gap-0.5 rounded-sm p-0.5" style={{ background: theme.background }} aria-hidden>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <span key={i} className="size-3 rounded-[3px]" style={{ background: theme.palette[i] }} />
          ))}
        </span>
      ) : (
        <span className="text-xs text-subtle">{t('appearance.defaultHint')}</span>
      )}
    </div>
  )
}
