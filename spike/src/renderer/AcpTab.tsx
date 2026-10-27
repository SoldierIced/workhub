import { useEffect, useRef, useState } from 'react'
import type { AcpEvent, AgentName, PermissionOptionView } from '../shared/api'

type Item =
  | { id: number; kind: 'user' | 'agent' | 'thought' | 'tool' | 'err' | 'info'; text: string; toolId?: string }
  | { id: number; kind: 'perm'; requestId: string; title: string; options: PermissionOptionView[]; done?: string }

let seq = 0

export function AcpTab() {
  const [agent, setAgent] = useState<AgentName>('kiro')
  const [cwd, setCwd] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.hub.getDefaultCwd().then(setCwd)
    return window.hub.acp.onEvent((e) => setItems((prev) => reduce(prev, e)))
  }, [])
  useEffect(() => {
    bottom.current?.scrollIntoView()
  }, [items])

  const push = (kind: 'info' | 'err' | 'user', t: string) =>
    setItems((p) => [...p, { id: ++seq, kind, text: t }])

  const start = async () => {
    setItems([])
    setReady(false)
    push('info', `Starting ${agent} in ${cwd} ...`)
    try {
      const r = await window.hub.acp.start(agent, cwd)
      push('info', `${r.agentName} ready. session=${r.sessionId} modes=[${r.modes.join(', ')}] ${r.mcpHint}`)
      setReady(true)
    } catch (e) {
      push('err', String(e))
    }
  }

  const send = async () => {
    const t = text.trim()
    if (!t || busy) return
    setText('')
    push('user', t)
    setBusy(true)
    try {
      const stop = await window.hub.acp.prompt(t)
      push('info', `[stop: ${stop}]`)
    } catch (e) {
      push('err', String(e))
    } finally {
      setBusy(false)
    }
  }

  const answer = (requestId: string, optionId: string | null, label: string) => {
    window.hub.acp.respondPermission(requestId, optionId)
    setItems((p) => p.map((i) => (i.kind === 'perm' && i.requestId === requestId ? { ...i, done: label } : i)))
  }

  return (
    <>
      <div className="bar">
        <select value={agent} onChange={(e) => setAgent(e.target.value as AgentName)} aria-label="Agent">
          <option value="kiro">Kiro (kiro-cli acp)</option>
          <option value="claude">Claude Code (claude-agent-acp)</option>
        </select>
        <input value={cwd} onChange={(e) => setCwd(e.target.value)} aria-label="Session folder" />
        <button onClick={() => void window.hub.pickFolder().then((d) => d && setCwd(d))}>Choose...</button>
        <button onClick={() => void start()}>Start session</button>
        <button onClick={() => void window.hub.acp.cancel()} disabled={!busy}>
          Cancel
        </button>
      </div>
      <div className="log">
        {items.map((i) =>
          i.kind === 'perm' ? (
            <div key={i.id} className="msg perm">
              Permission requested: {i.title}
              {i.done ? (
                <div>-&gt; {i.done}</div>
              ) : (
                <div className="perm-buttons">
                  {i.options.map((o) => (
                    <button key={o.optionId} onClick={() => answer(i.requestId, o.optionId, o.name)}>
                      {o.kind.startsWith('allow') ? 'Allow' : 'Deny'}: {o.name}
                    </button>
                  ))}
                  <button onClick={() => answer(i.requestId, null, 'cancelled')}>Cancel</button>
                </div>
              )}
            </div>
          ) : (
            <div key={i.id} className={`msg ${i.kind === 'agent' ? '' : i.kind}`}>
              {i.text}
            </div>
          )
        )}
        <div ref={bottom} />
      </div>
      <div className="input">
        <input
          value={text}
          disabled={!ready}
          placeholder={ready ? 'Prompt...' : 'Start a session first'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
          aria-label="Prompt"
        />
        <button onClick={() => void send()} disabled={!ready || busy}>
          Send
        </button>
      </div>
    </>
  )
}

function reduce(prev: Item[], e: AcpEvent): Item[] {
  if (e.type === 'permission') return [...prev, { id: ++seq, kind: 'perm', ...e }]
  if (e.type === 'exit') return [...prev, { id: ++seq, kind: 'err', text: `[agent process exited: ${e.code}]` }]
  if (e.type === 'stderr') return prev // stderr is noisy; the probe logs it
  const u = e.update
  const kind = u['sessionUpdate'] as string
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const content = u['content'] as { type: string; text?: string }
    if (content.type !== 'text') return prev
    const k = kind === 'agent_message_chunk' ? 'agent' : 'thought'
    const last = prev[prev.length - 1]
    if (last && last.kind === k) return [...prev.slice(0, -1), { ...last, text: last.text + (content.text ?? '') }]
    return [...prev, { id: ++seq, kind: k, text: content.text ?? '' }]
  }
  if (kind === 'tool_call') {
    const toolId = u['toolCallId'] as string
    return [...prev, { id: ++seq, kind: 'tool', toolId, text: `tool: ${u['title'] as string} (${u['status'] as string})` }]
  }
  if (kind === 'tool_call_update') {
    const toolId = u['toolCallId'] as string
    return prev.map((i) =>
      i.kind === 'tool' && i.toolId === toolId
        ? { ...i, text: `tool: ${(u['title'] as string | undefined) ?? i.text.replace(/^tool: | \(.*\)$/g, '')} (${(u['status'] as string | undefined) ?? '...'})` }
        : i
    )
  }
  return prev
}
