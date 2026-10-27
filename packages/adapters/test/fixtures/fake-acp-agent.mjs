// A minimal ACP agent over stdio for runtime tests. Replies to initialize, session/new and
// session/prompt; during a prompt it streams one message chunk, one tool call and a Kiro-style
// metadata notification. Prompt "ask" sends a permission request first.
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const sessionId = 'fake-session-1'
let nextId = 1000
const waiting = new Map()

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id !== undefined && !msg.method) {
    waiting.get(msg.id)?.(msg.result)
    waiting.delete(msg.id)
    return
  }
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'fake', title: 'Fake Agent', version: '0.0.0' } } })
  } else if (msg.method === 'session/new') {
    send({
      id: msg.id,
      result: {
        sessionId,
        modes: {
          currentModeId: 'bypassPermissions',
          availableModes: [
            { id: 'default', name: 'Manual' },
            { id: 'bypassPermissions', name: 'Bypass permissions' },
            { id: 'plan', name: 'Plan' }
          ]
        },
        models: { currentModelId: 'acme-model-1', availableModels: [{ modelId: 'acme-model-1', name: 'Acme 1' }, { modelId: 'acme-model-2', name: 'Acme 2' }] }
      }
    })
  } else if (msg.method === 'session/set_mode') {
    process.stderr.write(`set_mode:${msg.params.modeId}\n`)
    send({ id: msg.id, result: {} })
  } else if (msg.method === 'session/set_model') {
    process.stderr.write(`set_model:${msg.params.modelId}\n`)
    send({ id: msg.id, result: {} })
  } else if (msg.method === 'session/prompt') {
    const text = msg.params.prompt[0].text
    const update = (u) => send({ method: 'session/update', params: { sessionId, update: u } })
    const finish = (extra) => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}${extra}` } })
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read', status: 'completed' })
      send({ method: '_kiro.dev/metadata', params: { sessionId, contextUsagePercentage: 12.5, meteringUsage: [{ value: 0.25, unit: 'credit' }], turnDurationMs: 900 } })
      send({ id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } })
    }
    if (text === 'ask') {
      const id = nextId++
      waiting.set(id, (result) => finish(` (${result.outcome.outcome}:${result.outcome.optionId ?? '-'})`))
      send({
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 't0', title: 'Write file' },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
          ]
        }
      })
    } else finish('')
  } else if (msg.method === 'session/cancel') {
    // notification, nothing to answer
  } else if (msg.id !== undefined) {
    send({ id: msg.id, error: { code: -32601, message: 'method not found' } })
  }
})
