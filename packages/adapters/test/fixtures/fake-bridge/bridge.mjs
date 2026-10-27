// A fake of the Claude bridge (src/agent-claude-native/bridge/bridge.mjs) for the runtime tests:
// it speaks the same line protocol with canned answers and never starts Claude.
import readline from 'node:readline'

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const sdk = (message) => send({ type: 'sdk', message })
let start = null
let pendingPermission = null
let servers = [{ name: 'acme-docs', status: 'connected', toolCount: 2, tools: ['search', 'read'] }]

function reply(id, text) {
  sdk({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id } } })
  for (const part of text.match(/.{1,4}/g)) {
    sdk({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } })
  }
  sdk({ type: 'assistant', parent_tool_use_id: null, message: { id, model: 'claude-haiku-5', content: [{ type: 'text', text }] } })
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  switch (m.type) {
    case 'start':
      start = m
      send({ type: 'ready' })
      send({
        type: 'options',
        models: [{ value: 'default', displayName: 'Default', description: 'Recommended' }, { value: 'haiku', displayName: 'Haiku', description: 'Fastest' }],
        commands: [],
        defaults: { permissionMode: 'default', effort: null }
      })
      send({ type: 'mcp_status', servers })
      sdk({ type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', output: 'Remember the acme rules.', stdout: '', stderr: '', outcome: 'success' })
      break
    case 'user': {
      const text = m.text ?? m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
      if (text === 'echo start') {
        reply('msg_start', JSON.stringify({ cwd: process.cwd(), start, configEnv: process.env.CLAUDE_CONFIG_DIR ?? null }))
        sdk({ type: 'result', subtype: 'success', is_error: false })
      } else if (text === 'use a tool') {
        sdk({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_tool', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls', description: 'List files' } }] } })
        pendingPermission = 'perm-1'
        send({ type: 'permission_request', id: 'perm-1', toolName: 'Bash', input: { command: 'ls', description: 'List files' }, suggestions: [{ type: 'addRules' }] })
      } else if (text === 'wait') {
        // Answered by an interrupt.
      } else {
        const images = (m.content ?? []).filter((b) => b.type === 'image').length
        reply('msg_' + Date.now(), images ? `pong with ${images} image(s)` : 'pong')
        sdk({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1790000000 } })
        sdk({ type: 'result', subtype: 'success', is_error: false })
      }
      break
    }
    case 'permission':
      if (m.id === pendingPermission) {
        pendingPermission = null
        sdk({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: m.result.behavior !== 'allow' }] } })
        reply('msg_after', `permission ${m.result.behavior}${m.result.updatedPermissions ? ' always' : ''}`)
        sdk({ type: 'result', subtype: 'success', is_error: false })
      }
      break
    case 'interrupt':
      sdk({ type: 'result', subtype: 'error_during_execution', is_error: true })
      break
    case 'set_model':
      send({ type: 'option_error', name: 'model', message: `no model ${m.model}` })
      break
    case 'mcp_toggle':
      servers = servers.map((s) => (s.name === m.name ? { ...s, status: m.enabled ? 'connected' : 'disabled' } : s))
      send({ type: 'mcp_status', servers })
      break
    case 'mcp_status':
      send({ type: 'mcp_status', servers })
      break
  }
}).on('close', () => process.exit(0))
