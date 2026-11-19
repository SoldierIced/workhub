import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  emptyConfig,
  NO_CAPABILITIES,
  type AgentEvent,
  type AgentEventListener,
  type AgentRuntime,
  type ConfigurationService,
  type SessionHistorySource,
  type StartSessionRequest
} from '@workhub/core'
import { SessionManager } from '../src/main/session-manager'
import { runWorkhubCommand, sessionSlashCommands, workhubCommands } from '../src/renderer/lib/chatCommands'
import { sessionNameInfo } from '../src/renderer/lib/sessionGroups'
import { translate, type MessageKey, type Params } from '../src/renderer/i18n/translate'
import { SlashCommandMenu } from '../src/renderer/screens/sessions/SlashCommandMenu'
import type { ChatItem } from '../src/renderer/store'
import type { SessionView } from '../src/shared/api'

const t = (key: MessageKey, params?: Params) => translate('en', key, params)

const view = (over: Partial<SessionView> = {}): SessionView =>
  ({ id: 's1', agentId: 'claude', adapter: 'native', cwd: '/w/acme/api', agentName: 'Claude Code', ...over }) as unknown as SessionView

/** Actions that record what a command did; `rename` and `setModel` succeed unless told otherwise. */
function actions(fail = false) {
  const log: string[] = []
  return {
    log,
    rename: vi.fn(async (id: string, name: string) => {
      if (fail) throw new Error('disk full')
      log.push(`rename ${id} ${name}`)
    }),
    setModel: vi.fn(async (id: string, model: string) => {
      log.push(`model ${id} ${model}`)
    }),
    login: vi.fn(async (id: string) => {
      log.push(`login ${id}`)
      return !fail
    }),
    exit: vi.fn(async (id: string) => {
      if (fail) throw new Error('window is gone')
      log.push(`exit ${id}`)
    }),
    remoteControl: vi.fn(async (id: string) => {
      log.push(`remote-control ${id}`)
      return !fail
    }),
    terminal: vi.fn(async (id: string, line: string) => {
      log.push(`terminal ${id} ${line}`)
      return !fail
    }),
    report: (kind: 'done' | 'error', text: string) => log.push(`${kind}: ${text}`)
  }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('the composer\'s commands', () => {
  it('offers /rename first, then the agent\'s known built-ins until it reports its own', () => {
    const before = sessionSlashCommands(view(), t)
    expect(before[0]).toMatchObject({ name: 'rename', group: 'workhub', argumentHint: '<name>' })
    expect(before.map((c) => c.name)).toContain('compact')
    const after = sessionSlashCommands(view({ commands: [{ name: 'deploy-docs', group: 'skill' }, { name: 'rename', group: 'agent' }] }), t)
    // The agent's own /rename is hidden by Workhub's.
    expect(after.map((c) => `${c.group}:${c.name}`)).toEqual(['workhub:rename', 'workhub:exit', 'skill:deploy-docs'])
  })

  it('owns /model only for agents whose model it switches (not Claude, which runs its own)', () => {
    const models = [{ id: 'acme-model-1', name: 'Acme 1' }, { id: 'acme-model-2', name: 'Acme 2' }]
    expect(workhubCommands(view({ modelControl: true, models }), t).map((c) => c.name)).toEqual(['rename', 'exit'])
    expect(workhubCommands(view({ agentId: 'kiro', adapter: 'acp', modelControl: true, models }), t).map((c) => c.name)).toEqual(['rename', 'model', 'exit'])
  })
})

describe('runWorkhubCommand', () => {
  it('renames the session and never sends /rename to the agent', async () => {
    const a = actions()
    expect(runWorkhubCommand(view(), '/rename  Payments   refactor ', a, t)).toBe(true)
    await settle()
    expect(a.log).toEqual(['rename s1 Payments refactor', 'done: Renamed the session to “Payments refactor”'])
  })

  it('answers /rename without a name with its usage, and reports a failed rename', async () => {
    const a = actions()
    expect(runWorkhubCommand(view(), '/rename', a, t)).toBe(true)
    expect(a.rename).not.toHaveBeenCalled()
    expect(a.log).toEqual(['error: Usage: /rename <name>'])
    const failing = actions(true)
    runWorkhubCommand(view(), '/rename Foo', failing, t)
    await settle()
    expect(failing.log).toEqual(['error: Could not rename the session: disk full'])
  })

  it('leaves agent commands, unknown commands and plain prompts to the agent', () => {
    const a = actions()
    for (const text of ['/compact', '/model haiku', '/acme:unknown thing', 'rename this', '/w/acme/api fails']) expect(runWorkhubCommand(view(), text, a, t)).toBe(false)
    expect(a.log).toEqual([])
  })

  it('switches an ACP agent\'s model by id or name', async () => {
    const v = view({ agentId: 'kiro', adapter: 'acp', modelControl: true, models: [{ id: 'acme-model-1', name: 'Acme 1' }, { id: 'acme-model-2', name: 'Acme 2' }] })
    const a = actions()
    expect(runWorkhubCommand(v, '/model acme 2', a, t)).toBe(true)
    expect(runWorkhubCommand(v, '/model nope', a, t)).toBe(true)
    await settle()
    expect(a.log).toEqual(['model s1 acme-model-2', 'error: No model “nope”. Models: acme-model-1, acme-model-2', 'done: Switched to Acme 2'])
  })
})

describe('/login', () => {
  it('is Workhub\'s for Claude in the chat when the session has a console, and not for other agents', () => {
    expect(workhubCommands(view({ modes: ['app', 'console', 'shell'] }), t).map((c) => c.name)).toEqual(['rename', 'login', 'remote-control', 'exit'])
    expect(workhubCommands(view({ modes: ['app'] }), t).map((c) => c.name)).toEqual(['rename', 'exit'])
    expect(workhubCommands(view({ agentId: 'kiro', adapter: 'acp', modes: ['app', 'console'] }), t).map((c) => c.name)).toEqual(['rename', 'exit'])
    expect(runWorkhubCommand(view({ agentId: 'kiro', adapter: 'acp', modes: ['app', 'console'] }), '/login', actions(), t)).toBe(false)
  })

  it('opens the console and types /login there, and says so', async () => {
    const a = actions()
    expect(runWorkhubCommand(view({ modes: ['app', 'console'] }), '/login', a, t)).toBe(true)
    await settle()
    expect(a.log).toEqual(['login s1', 'done: Sign in in the Terminal view. Once done, go back to App (⌘⌥1 or Ctrl+Alt+1).'])
    const late = actions(true)
    runWorkhubCommand(view({ modes: ['app', 'console'] }), '/login', late, t)
    await settle()
    expect(late.log.at(-1)).toBe('error: The Terminal view did not come up in time. Type /login there yourself.')
  })
})

describe('terminal-bound commands', () => {
  const claude = (over: Partial<SessionView> = {}) => view({ modes: ['app', 'console'], ...over })
  const reported = [
    { name: 'plugin', group: 'agent' as const, terminal: true },
    { name: 'usage', group: 'agent' as const, aliases: ['stats'] },
    { name: 'compact', group: 'agent' as const }
  ]

  it('lists them in the menu for a Claude chat with a console, and hides them elsewhere', () => {
    expect(sessionSlashCommands(claude({ commands: reported }), t).find((c) => c.name === 'plugin')?.terminal).toBe(true)
    expect(sessionSlashCommands(claude(), t).map((c) => c.name)).toEqual(expect.arrayContaining(['config', 'resume', 'plugin']))
    expect(sessionSlashCommands(claude(), t).map((c) => c.name)).not.toContain('model')
    expect(sessionSlashCommands(view({ commands: reported }), t).map((c) => c.name)).not.toContain('plugin')
    expect(sessionSlashCommands(claude({ commands: reported }), t).find((c) => c.name === 'usage')?.aliases).toEqual(['stats'])
  })

  it('types a reported terminal command, with its arguments, in the console and says so', async () => {
    const a = actions()
    expect(runWorkhubCommand(claude({ commands: reported }), '/plugin install acme', a, t)).toBe(true)
    await settle()
    expect(a.log).toEqual(['terminal s1 /plugin install acme', 'done: /plugin ran in the Terminal view. Go back to App (⌘⌥1 or Ctrl+Alt+1) when you are done.'])
    const late = actions(true)
    runWorkhubCommand(claude({ commands: reported }), '/plugin', late, t)
    await settle()
    expect(late.log.at(-1)).toBe('error: The Terminal view did not come up in time. Type /plugin there yourself.')
  })

  it('leaves SDK commands, unreported names and sessions without a console to the agent', () => {
    for (const text of ['/compact', '/stats', '/config', '/plugin\n/exit']) expect(runWorkhubCommand(claude({ commands: reported }), text, actions(), t)).toBe(false)
    expect(runWorkhubCommand(view({ commands: reported }), '/plugin', actions(), t)).toBe(false)
    expect(runWorkhubCommand(claude(), '/config', actions(), t)).toBe(true)
  })
})

describe('/exit', () => {
  it('is Workhub\'s for every session, without arguments, and hides an agent\'s own /exit', () => {
    for (const v of [view(), view({ agentId: 'kiro', adapter: 'acp' }), view({ agentId: 'codex', adapter: 'acp', modes: ['app'] })]) {
      const exit = workhubCommands(v, t).find((c) => c.name === 'exit')
      expect(exit).toEqual({ name: 'exit', group: 'workhub', description: 'Close this session' })
    }
    const listed = sessionSlashCommands(view({ commands: [{ name: 'exit', group: 'agent' }, { name: 'compact', group: 'agent' }] }), t)
    expect(listed.filter((c) => c.name === 'exit').map((c) => c.group)).toEqual(['workhub'])
  })

  it('closes the session and never sends /exit to the agent, whatever follows it', async () => {
    for (const text of ['/exit', '/exit now please', ' /EXIT ']) {
      const a = actions()
      expect(runWorkhubCommand(view(), text, a, t)).toBe(true)
      await settle()
      // A session that closes needs no "done" line in its chat.
      expect(a.log).toEqual(['exit s1'])
    }
    const acp = actions()
    expect(runWorkhubCommand(view({ id: 's2', agentId: 'kiro', adapter: 'acp' }), '/exit', acp, t)).toBe(true)
    await settle()
    expect(acp.log).toEqual(['exit s2'])
  })

  it('reports in the chat when the session could not be closed', async () => {
    const a = actions(true)
    expect(runWorkhubCommand(view(), '/exit', a, t)).toBe(true)
    await settle()
    expect(a.log).toEqual(['error: Could not close the session: window is gone'])
  })

  it('leaves a command that only starts with exit to the agent', () => {
    const a = actions()
    for (const text of ['/exit-plan-mode', '/exits', 'exit']) expect(runWorkhubCommand(view(), text, a, t)).toBe(false)
    expect(a.exit).not.toHaveBeenCalled()
  })
})

describe('/remote-control', () => {
  const claude = () => view({ modes: ['app', 'console'] })

  it('is in the menu only for Claude with a console', () => {
    expect(workhubCommands(claude(), t).map((c) => c.name)).toContain('remote-control')
    expect(workhubCommands(view({ modes: ['app'] }), t).map((c) => c.name)).not.toContain('remote-control')
    expect(workhubCommands(view({ agentId: 'kiro', adapter: 'acp', modes: ['app', 'console'] }), t).map((c) => c.name)).not.toContain('remote-control')
  })

  it('routes /remote-control and /rc to the console and never to the agent', async () => {
    for (const text of ['/remote-control', '/rc', '/RC']) {
      const a = actions()
      expect(runWorkhubCommand(claude(), text, a, t)).toBe(true)
      await settle()
      expect(a.log[0]).toBe('remote-control s1')
      expect(a.log[1]).toMatch(/^done: Remote Control is on .*only while the Terminal view runs.*switching back to App ends it/)
      expect(a.login).not.toHaveBeenCalled()
    }
  })

  it('is left to the agent where Workhub does not own it', () => {
    for (const v of [view({ modes: ['app'] }), view({ agentId: 'kiro', adapter: 'acp', modes: ['app', 'console'] })]) {
      expect(runWorkhubCommand(v, '/remote-control', actions(), t)).toBe(false)
      expect(runWorkhubCommand(v, '/rc', actions(), t)).toBe(false)
    }
  })

  it('reports a console that did not come up and one that failed', async () => {
    const late = actions(true)
    runWorkhubCommand(claude(), '/rc', late, t)
    await settle()
    expect(late.log.at(-1)).toBe('error: The Terminal view did not come up in time. Type /remote-control there yourself.')
    const broken = actions()
    broken.remoteControl.mockRejectedValueOnce(new Error('no pty'))
    runWorkhubCommand(claude(), '/remote-control', broken, t)
    await settle()
    expect(broken.log.at(-1)).toBe('error: Could not open the Terminal view to turn on Remote Control: no pty')
  })
})

describe('the / menu', () => {
  it('lists the matches by group with their hints and descriptions', () => {
    const html = renderToStaticMarkup(
      createElement(SlashCommandMenu, {
        sessionId: 's1',
        agentName: 'Claude Code',
        commands: [
          { name: 'rename', group: 'workhub', argumentHint: '<name>', description: 'Rename this session' },
          { name: 'compact', group: 'agent', description: 'Compact' },
          { name: 'deploy-docs', group: 'skill' }
        ],
        selected: 1,
        onPick: () => {},
        onHover: () => {}
      })
    )
    expect(html).toContain('role="listbox"')
    expect(html.match(/role="option"/g)).toHaveLength(3)
    expect(html).toContain('Workhub')
    expect(html).toContain('Claude Code')
    expect(html).toContain('Skills and custom commands')
    expect(html).toContain('/rename')
    expect(html).toContain('&lt;name&gt;')
    expect(html).toMatch(/id="slash-s1-1"[^>]*aria-selected="true"/)
  })
})

describe('session names and commands', () => {
  const items = (...texts: string[]): ChatItem[] => texts.map((text, i) => ({ id: i, kind: 'user', text }))

  it('names a row by the user\'s name, else the agent\'s title, else the first real prompt', () => {
    expect(sessionNameInfo({ view: view({ name: 'Mine', agentTitle: 'Fix the login' }), items: items('hello') }).title).toBe('Mine')
    expect(sessionNameInfo({ view: view({ agentTitle: 'Fix the login' }), items: items('hello') }).title).toBe('Fix the login')
    // A bare command says nothing about the session.
    expect(sessionNameInfo({ view: view(), items: items('/clear', 'fix the build') }).title).toBe('fix the build')
  })

  function harness(history: Partial<Record<string, SessionHistorySource>> = {}) {
    let listener: AgentEventListener = () => {}
    const runtime: AgentRuntime = {
      adapter: 'native',
      capabilities: () => ({ ...NO_CAPABILITIES, appMode: true }),
      start: async (r: StartSessionRequest) => ({ agentName: 'Claude Code', permissionMode: null, agentSessionId: r.agentSessionId }),
      prompt: async () => ({ stopReason: 'end_turn' }),
      cancel: async () => {},
      stop: async () => {},
      stopAll: async () => {},
      respondPermission: () => {},
      subscribe: (l) => {
        listener = l
        return () => {}
      }
    }
    const changed: SessionView[] = []
    const manager = new SessionManager({
      config: { current: async () => emptyConfig(), replaceSessionIdentity: async () => undefined } as unknown as ConfigurationService,
      runtimes: { native: runtime },
      terminal: runtime,
      transcripts: [],
      history,
      emitEvent: () => {},
      emitChanged: (s) => changed.push(s),
      emitReplay: () => {},
      pollMs: 60_000
    })
    return { manager, changed, emit: (e: AgentEvent) => listener(e) }
  }

  it('renames the sidebar row and the Claude transcript through the same path as the sidebar', async () => {
    const renamed: string[] = []
    const claude: SessionHistorySource = {
      list: async () => [],
      messages: async () => [],
      rename: async (id, cwd, title) => {
        renamed.push(`${id} ${cwd} ${title}`)
      }
    }
    const { manager, changed } = harness({ claude })
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    manager.rename(v.id, ' Foo ')
    expect(changed.at(-1)).toMatchObject({ id: v.id, name: 'Foo' })
    expect(renamed).toEqual([`${v.agentSessionId} /w/acme/api Foo`])
    // Going back to no name leaves the transcript alone.
    manager.rename(v.id, null)
    expect(renamed).toHaveLength(1)
  })

  it('keeps the commands and the title the agent reports on the session', async () => {
    const { manager, changed, emit } = harness()
    const v = await manager.start({ profileId: null, agentKey: 'claude', cwd: '/w/acme/api' })
    emit({ sessionId: v.id, type: 'commands', commands: [{ name: 'compact', group: 'agent' }] })
    expect(changed.at(-1)?.commands).toEqual([{ name: 'compact', group: 'agent' }])
    emit({ sessionId: v.id, type: 'monitor', snapshot: { title: '  Fix the login form ' } })
    expect(changed.at(-1)?.agentTitle).toBe('Fix the login form')
  })
})
