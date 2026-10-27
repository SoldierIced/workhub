import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentIcon } from '../src/renderer/components/atoms/AgentIcon'
import { describe, expect, it } from 'vitest'
import { agentGlyph } from '../src/renderer/lib/agents'
import { sessionName } from '../src/renderer/lib/sessionGroups'
import type { SessionData } from '../src/renderer/store'

describe('agentGlyph', () => {
  it('maps known agents, their variants and account keys to their mark', () => {
    expect(agentGlyph('claude')).toBe('claude')
    expect(agentGlyph('claude-acp')).toBe('claude')
    expect(agentGlyph('claude:work')).toBe('claude')
    expect(agentGlyph('kiro')).toBe('kiro')
    expect(agentGlyph('codex')).toBe('codex')
    expect(agentGlyph('opencode')).toBe('opencode')
    expect(agentGlyph('gemini')).toBe('gemini')
  })

  it('gives shells and terminal agents the terminal mark and everything else the generic one', () => {
    expect(agentGlyph('zsh')).toBe('shell')
    expect(agentGlyph('my-cli', 'terminal')).toBe('shell')
    expect(agentGlyph('my-agent', 'acp')).toBe('generic')
    expect(agentGlyph('claudette')).toBe('generic')
  })
})

describe('sessionName', () => {
  const data = (items: SessionData['items'], cwd = '/work/shop-api') => ({ items, view: { cwd } }) as unknown as SessionData

  it('is the first line of the first prompt', () => {
    expect(sessionName(data([{ id: 1, kind: 'user', text: '\n  Fix the   login bug\nmore detail' }]))).toBe('Fix the login bug')
  })

  it('truncates a long prompt', () => {
    const name = sessionName(data([{ id: 1, kind: 'user', text: 'x'.repeat(200) }]))
    expect(name.length).toBe(60)
    expect(name.endsWith('…')).toBe(true)
  })

  it('falls back to the folder before anything is asked', () => {
    expect(sessionName(data([]))).toBe('shop-api')
    expect(sessionName(data([{ id: 1, kind: 'user', text: '  ' }]))).toBe('shop-api')
  })
})

describe('AgentIcon', () => {
  const html = (agentId: string, adapter?: string) => renderToStaticMarkup(createElement(AgentIcon, { agentId, adapter, label: agentId }))

  it('shows the logo of Claude (SDK and ACP), Codex and Kiro', () => {
    for (const id of ['claude', 'claude-acp', 'claude:work']) expect(html(id)).toContain('data-agent-logo="claude"')
    expect(html('codex')).toContain('data-agent-logo="codex"')
    expect(html('kiro')).toContain('data-agent-logo="kiro"')
    expect(html('claude')).toContain('<svg')
  })

  it('keeps the letter fallback for agents without a logo and the terminal mark for shells', () => {
    expect(html('opencode')).toContain('>Oc<')
    expect(html('gemini')).toContain('>G<')
    expect(html('opencode')).not.toContain('<svg')
    expect(html('zsh')).toContain('data-agent-icon="shell"')
    expect(html('my-agent', 'acp')).toContain('data-agent-icon="generic"')
  })
})
