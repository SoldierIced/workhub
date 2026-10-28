import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { SessionView } from '../src/shared/api'
import { SessionControls } from '../src/renderer/screens/sessions/SessionControls'

const view = (over: Partial<SessionView>): SessionView =>
  ({
    id: 's1',
    agentId: 'claude',
    mode: 'app',
    state: 'ready',
    readOnly: false,
    permissionMode: { id: 'default', label: 'Ask before editing', source: 'workhub', unattended: false },
    ...over
  }) as unknown as SessionView

const html = (v: SessionView, reportedModel?: string) => renderToStaticMarkup(createElement(SessionControls, { view: v, reportedModel }))

describe('SessionControls', () => {
  it('shows the running model and the permission mode as static labels when the agent offers no switch', () => {
    const out = html(view({}), 'Opus 5.5')
    expect(out).toContain('data-testid="composer-controls"')
    expect(out).toContain('Opus 5.5')
    expect(out).toContain('Ask before editing')
    expect(out).not.toContain('<button')
  })

  it('renders switchable pickers as accessible menu buttons', () => {
    const out = html(
      view({
        models: [{ id: 'opus', name: 'Opus' }],
        currentModelId: 'opus',
        modelControl: true,
        availableModes: [
          { id: 'default', name: 'Ask before editing' },
          { id: 'bypass', name: 'Bypass permissions' }
        ],
        currentModeId: 'default',
        modeControl: true
      })
    )
    expect(out.match(/<button/g)).toHaveLength(2)
    expect(out).toContain('aria-label="Model"')
    expect(out).toContain('aria-label="Mode"')
  })

  it('tints the permission control while tools run without asking', () => {
    const out = html(view({ permissionMode: { id: 'bypass', label: 'Bypass permissions', source: 'workhub', unattended: true } }))
    expect(out).toContain('text-warning')
    expect(html(view({}))).not.toContain('text-warning')
  })
})

describe('composer layout', () => {
  it('places the controls in the composer card’s bottom bar: after the input, before the send button', () => {
    const src = readFileSync(new URL('../src/renderer/screens/sessions/ChatPane.tsx', import.meta.url), 'utf8')
    const card = src.indexOf('rounded-xl border border-border bg-surface shadow-sm')
    const input = src.indexOf("aria-label={t('chat.prompt')}")
    const controls = src.indexOf('<SessionControls')
    const send = src.indexOf("label={t('chat.send')}")
    expect(card).toBeGreaterThan(-1)
    expect(input).toBeGreaterThan(card)
    expect(controls).toBeGreaterThan(input)
    expect(send).toBeGreaterThan(controls)
    expect(src).not.toContain('SessionFacts')
  })
})
