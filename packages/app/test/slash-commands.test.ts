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
    expect(after.map((c) => `${c.group}:${c.name}`)).toEqual(['workhub:rename', 'skill:deploy-docs'])
  })

  it('owns /model only for agents whose model it switches (not Claude, which runs its own)', () => {
    const models = [{ id: 'acme-model-1', name: 'Acme 1' }, { id: 'acme-model-2', name: 'Acme 2' }]
    expect(workhubCommands(view({ modelControl: true, models }), t).map((c) => c.name)).toEqual(['rename'])
    expect(workhubCommands(view({ agentId: 'kiro', adapter: 'acp', modelControl: true, models }), t).map((c) => c.name)).toEqual(['rename', 'model'])
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
