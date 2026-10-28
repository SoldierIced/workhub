// A fake ACP agent for demos and smoke tests: no model, no network, no cost. Each process is a
// new session with its own id; a prompt "runs" for a second and answers "done: <prompt>" (images are
// accepted and ignored, so pasting can be exercised).
// Use it as a custom agent: { adapter: "acp", command: "node", args: ["<path>/demo-agent.mjs"] }.
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const sessionId = randomUUID()

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: true } }, authMethods: [], agentInfo: { name: 'demo', title: 'Demo agent', version: '0.0.0' } } })
  } else if (msg.method === 'session/new') {
    send({ id: msg.id, result: { sessionId } })
  } else if (msg.method === 'session/prompt') {
    const text = msg.params.prompt.map((p) => p.text ?? '').join('')
    setTimeout(() => {
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `done: ${text}` } } } })
      send({ id: msg.id, result: { stopReason: 'end_turn' } })
    }, 1_000)
  } else if (msg.id !== undefined && msg.method) {
    send({ id: msg.id, error: { code: -32601, message: 'method not found' } })
  }
})
