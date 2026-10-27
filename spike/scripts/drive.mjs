import { writeFileSync } from 'node:fs'
// Tiny CDP driver for manual smoke tests: node scripts/drive.mjs '<json steps>'
// Steps: {eval: "js"} | {type: "text"} | {key: "Enter"} | {wait: ms} | {bringToFront: true} | {shot: "file.png"}
// Requires the app to be running with --remote-debugging-port=9222.
const targets = await (await fetch('http://localhost:9222/json')).json()
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) pending.get(d.id)(d)
}
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })

for (const step of JSON.parse(process.argv[2])) {
  if (step.eval) {
    const r = await call('Runtime.evaluate', { expression: step.eval, awaitPromise: true, returnByValue: true })
    console.log(JSON.stringify(r.result.result?.value ?? r.result.exceptionDetails ?? null))
  } else if (step.type) await call('Input.insertText', { text: step.type })
  else if (step.key) {
    const base = { key: step.key, code: step.key, windowsVirtualKeyCode: 13, text: '\r' }
    await call('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  } else if (step.shot) {
    const r = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(step.shot, Buffer.from(r.result.data, 'base64'))
  } else if (step.wait) await new Promise((r) => setTimeout(r, step.wait))
  else if (step.bringToFront) await call('Page.bringToFront')
}
ws.close()
