// A minimal ACP agent over stdio for runtime tests. Replies to initialize, session/new and
// session/prompt; during a prompt it streams one message chunk, one tool call and a Kiro-style
// metadata notification. Prompt "ask" sends a permission request first; prompt "agent-switch"
// makes the agent change its own mode (and model, in config style) before answering.
//
// FAKE_ACP_STYLE picks how session/new advertises models and modes:
// - unset: ACP `modes` (permission modes) and `models` (session/set_mode, session/set_model).
// - `config`: `configOptions` with `mode` and `model` selects (session/set_config_option), as
//   claude-agent-acp does.
// - `kiro`: `modes` that are agents (personas) and Kiro-like model ids.
import { createInterface } from 'node:readline'

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const sessionId = 'fake-session-1'
const style = process.env.FAKE_ACP_STYLE ?? ''
const MODES = {
  '': [
    { id: 'default', name: 'Manual' },
    { id: 'bypassPermissions', name: 'Bypass permissions' },
    { id: 'plan', name: 'Plan' }
  ],
  kiro: [
    { id: 'kiro_default', name: 'kiro_default', description: 'Default agent' },
    { id: 'explorer', name: 'explorer', description: 'Read-only code mapper' },
    { id: 'writer', name: 'writer' }
  ]
}
const MODELS = {
  '': [{ modelId: 'acme-model-1', name: 'Acme 1' }, { modelId: 'acme-model-2', name: 'Acme 2' }],
  kiro: [{ modelId: 'auto', name: 'auto', description: 'Models chosen by task' }, { modelId: 'claude-sonnet-5.5', name: 'claude-sonnet-5.5' }]
}
const modes = MODES[style === 'kiro' ? 'kiro' : '']
const models = MODELS[style === 'kiro' ? 'kiro' : '']
let currentMode = style === 'kiro' ? 'kiro_default' : 'bypassPermissions'
let currentModel = models[0].modelId
const configOptions = () => [
  { type: 'select', id: 'mode', category: 'mode', name: 'Mode', currentValue: currentMode, options: modes.map((m) => ({ value: m.id, name: m.name })) },
  // Grouped options, as the schema allows.
  { type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: currentModel, options: [{ group: 'all', name: 'All', options: models.map((m) => ({ value: m.modelId, name: m.name })) }] },
  { type: 'boolean', id: 'fast', name: 'Fast', currentValue: false }
]
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
    const result =
      style === 'config'
        ? { sessionId, configOptions: configOptions() }
        : { sessionId, modes: { currentModeId: currentMode, availableModes: modes }, models: { currentModelId: currentModel, availableModels: models } }
    send({ id: msg.id, result })
  } else if (msg.method === 'session/set_mode') {
    process.stderr.write(`set_mode:${msg.params.modeId}\n`)
    if (!modes.some((m) => m.id === msg.params.modeId)) send({ id: msg.id, error: { code: -32602, message: 'unknown mode' } })
    else {
      currentMode = msg.params.modeId
      send({ id: msg.id, result: {} })
    }
  } else if (msg.method === 'session/set_model') {
    process.stderr.write(`set_model:${msg.params.modelId}\n`)
    currentModel = msg.params.modelId
    send({ id: msg.id, result: {} })
  } else if (msg.method === 'session/set_config_option') {
    process.stderr.write(`set_config_option:${msg.params.configId}=${msg.params.value}\n`)
    if (msg.params.configId === 'mode') currentMode = msg.params.value
    if (msg.params.configId === 'model') currentModel = msg.params.value
    send({ id: msg.id, result: { configOptions: configOptions() } })
  } else if (msg.method === 'session/prompt') {
    const text = msg.params.prompt[0].text
    const update = (u) => send({ method: 'session/update', params: { sessionId, update: u } })
    const finish = (extra) => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo: ${text}${extra}` } })
      update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read', status: 'completed' })
      send({ method: '_kiro.dev/metadata', params: { sessionId, contextUsagePercentage: 12.5, meteringUsage: [{ value: 0.25, unit: 'credit' }], turnDurationMs: 900 } })
      send({ id: msg.id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } })
    }
    if (text === 'agent-switch') {
      currentMode = modes[modes.length - 1].id
      if (style === 'config') {
        currentModel = models[models.length - 1].modelId
        update({ sessionUpdate: 'config_option_update', configOptions: configOptions() })
      } else update({ sessionUpdate: 'current_mode_update', currentModeId: currentMode })
      finish('')
    } else if (text === 'ask') {
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
