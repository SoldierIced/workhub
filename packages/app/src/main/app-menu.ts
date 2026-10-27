import type { MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/windows-api'
import type { SetupPage } from '../shared/setup-api'

/** An agent the File menu offers a new session of (the active profile's effective agents, in order). */
export interface MenuAgent {
  /** `EffectiveAgent.key`. */
  key: string
  /** What the menu shows, e.g. "Claude Code - Work". */
  label: string
  agentId: string
}

export interface AppMenuInput {
  platform: NodeJS.Platform
  appName: string
  agents: readonly MenuAgent[]
  /** Labels in the user's language (the renderer's dictionaries, see tray-text.ts). */
  t: (key: string, params?: Record<string, string | number>) => string
  /** Runs a command in the window it belongs to (main decides which). */
  run: (command: MenuCommand) => void
  /** Help → the project's page. */
  openHelp: () => void
  /** Help → the setup windows (setup check, welcome, how Workhub works). */
  openSetup?: (page: SetupPage) => void
  /** Reload and developer tools in the View menu (dev runs only). */
  developer: boolean
}

/** The main navigation in Workhub 1's order and keys (⌘1-⌘8); routes match the renderer's `NAV_ITEMS`. */
export const MENU_ROUTES: readonly { route: string; key: string; label: string }[] = [
  { route: 'home', key: '1', label: 'nav.home' },
  { route: 'pullRequests', key: '2', label: 'nav.pullRequests' },
  { route: 'tickets', key: '3', label: 'nav.tickets' },
  { route: 'slack', key: '4', label: 'nav.slack' },
  { route: 'automations', key: '5', label: 'nav.automations' },
  { route: 'history', key: '6', label: 'nav.history' },
  { route: 'flows', key: '7', label: 'nav.flows' },
  { route: 'health', key: '8', label: 'nav.health' }
]

const MODES = [
  { mode: 'app', key: '1', label: 'menu.showApp' },
  { mode: 'console', key: '2', label: 'menu.showConsole' },
  { mode: 'shell', key: '3', label: 'menu.showShell' }
] as const

/**
 * Workhub 1's keys for new sessions: the first two agents get ⌘T and ⌘L (Claude and the second
 * Claude account there), a plain shell ⌘Y. Agents beyond those have no key.
 */
export function newSessionKeys(agents: readonly MenuAgent[]): Map<string, string> {
  const keys = new Map<string, string>()
  const free = ['T', 'L']
  for (const a of agents) {
    if (a.agentId === 'shell') {
      if (![...keys.values()].includes('Y')) keys.set(a.key, 'Y')
      continue
    }
    const next = free.shift()
    if (next) keys.set(a.key, next)
  }
  return keys
}

/**
 * The native application menu (macOS menu bar; the window menu on Windows and Linux), mirroring
 * Workhub 1's commands. Every Workhub command goes through `run`; the renderer of the target window
 * acts on it, so the keys it already handles (⌘1-⌘8, ⌘T) keep working with or without the menu.
 */
export function buildAppMenuTemplate(input: AppMenuInput): MenuItemConstructorOptions[] {
  const { t, run } = input
  const mac = input.platform === 'darwin'
  const keys = newSessionKeys(input.agents)

  const newSessions: MenuItemConstructorOptions[] = input.agents.length
    ? input.agents.map((a) => {
        const key = keys.get(a.key)
        return { label: t('menu.newAgentSession', { agent: a.label }), ...(key ? { accelerator: `CmdOrCtrl+${key}` } : {}), click: () => run({ kind: 'newSession', agentKey: a.key }) }
      })
    : [{ label: t('menu.newSession'), accelerator: 'CmdOrCtrl+T', click: () => run({ kind: 'newSession' }) }]

  const file: MenuItemConstructorOptions = {
    label: t('menu.file'),
    submenu: [
      ...newSessions,
      { type: 'separator' },
      { label: t('menu.openInNewWindow'), accelerator: 'CmdOrCtrl+Shift+N', click: () => run({ kind: 'openInWindow' }) },
      { label: t('menu.closeSession'), accelerator: 'CmdOrCtrl+Shift+W', click: () => run({ kind: 'closeSession' }) },
      { type: 'separator' },
      mac ? { role: 'close' } : { role: 'quit' }
    ]
  }

  const view: MenuItemConstructorOptions = {
    label: t('menu.view'),
    submenu: [
      ...MENU_ROUTES.map((r): MenuItemConstructorOptions => ({ label: t(r.label), accelerator: `CmdOrCtrl+${r.key}`, click: () => run({ kind: 'navigate', route: r.route }) })),
      { label: t('nav.sessions'), accelerator: 'CmdOrCtrl+0', click: () => run({ kind: 'navigate', route: 'sessions' }) },
      { type: 'separator' },
      ...MODES.map((m): MenuItemConstructorOptions => ({ label: t(m.label), accelerator: `CmdOrCtrl+Alt+${m.key}`, click: () => run({ kind: 'showMode', mode: m.mode }) })),
      { type: 'separator' },
      ...(input.developer ? ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[]) : []),
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }

  const help: MenuItemConstructorOptions = {
    role: 'help',
    label: t('menu.help'),
    submenu: [
      ...(input.openSetup
        ? ([
            { label: t('menu.setupCheck'), click: () => input.openSetup?.('check') },
            { label: t('menu.welcome'), click: () => input.openSetup?.('welcome') },
            { label: t('menu.howItWorks', { app: input.appName }), click: () => input.openSetup?.('help') },
            { type: 'separator' }
          ] as MenuItemConstructorOptions[])
        : []),
      { label: t('menu.helpPage', { app: input.appName }), click: input.openHelp }
    ]
  }

  // Settings sits in the app menu on macOS (⌘,) and in File elsewhere.
  const settings: MenuItemConstructorOptions = { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => run({ kind: 'navigate', route: 'settings' }) }
  if (!mac) (file.submenu as MenuItemConstructorOptions[]).splice(-1, 0, settings, { type: 'separator' })

  return [
    ...(mac
      ? [
          {
            label: input.appName,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settings,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    file,
    // Copy, paste and undo work in text fields only through the Edit menu's roles on macOS.
    { role: 'editMenu', label: t('menu.edit') },
    view,
    ...(mac ? [{ role: 'windowMenu', label: t('menu.window') } satisfies MenuItemConstructorOptions] : []),
    help
  ]
}
