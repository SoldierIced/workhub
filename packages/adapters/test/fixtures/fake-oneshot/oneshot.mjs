// Test stand-in for oneshot.mjs: echoes the request it got inside a valid digest answer.
import readline from 'node:readline'

const lines = readline.createInterface({ input: process.stdin })
for await (const line of lines) {
  if (!line.trim()) continue
  const request = JSON.parse(line)
  const result = JSON.stringify({ channels: [{ id: 'C01', messages: [{ ts: '1761566400.000100', user: 'ana', text: 'https://github.com/acme/web/pull/9' }] }], threads: [], me: request.configDir ?? 'default' })
  console.log('login shell noise')
  console.log(JSON.stringify({ ok: true, result, rateLimited: false, costUsd: 0.001, slackTools: ['mcp__claude_ai_Slack__slack_read_channel'], deniedTools: [], echo: request }))
  break
}
