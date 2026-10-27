import { writeFileSync } from 'node:fs'
// Tiny CDP driver for smoke tests (from the P0 spike): node scripts/drive.mjs '<json steps>'
// Steps: {eval: "js"} | {fill: ["css selector", "value"]} | {select: ["css selector", "value"]}
//        | {click: "css selector" | ["css selector", "button text"]} | {waitFor: "js expr", ms?}
//        | {wait: ms} | {shot: "file.png"}
//        | {tap: "css selector" | ["css selector", "text"]}  real mouse press at the element's center (Radix triggers need it)
//        | {press: "Enter"}  a real key press (Enter, Escape, ArrowDown, Tab...)
// Requires the app to be running with --remote-debugging-port (default 9222, or CDP_PORT).
const port = process.env.CDP_PORT ?? '9222'
const targets = await (await fetch(`http://localhost:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && (!process.env.CDP_URL_MATCH || t.url.includes(process.env.CDP_URL_MATCH)))
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
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails))
  return r.result.result?.value
}
// React tracks input values itself: set through the native setter, then fire the event it listens to.
const setValue = (sel, value, event) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) throw new Error('not found: ' + ${JSON.stringify(sel)});
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
  return el.value;
})()`
const click = (target) => {
  const [sel, text] = Array.isArray(target) ? target : [target, null]
  return `(() => {
    const all = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.offsetParent !== null);
    const el = ${JSON.stringify(text)} === null ? all[0] : all.find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!el) throw new Error('not found: ' + ${JSON.stringify(sel)} + ' ' + ${JSON.stringify(text)});
    el.click();
    return el.textContent.trim().slice(0, 60);
  })()`
}

const centerOf = (target) => {
  const [sel, text] = Array.isArray(target) ? target : [target, null]
  return `(() => {
    const all = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.getClientRects().length > 0);
    const el = ${JSON.stringify(text)} === null ? all[0] : all.find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}));
    if (!el) throw new Error('not found: ' + ${JSON.stringify(sel)} + ' ' + ${JSON.stringify(text)});
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`
}
const KEYS = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Tab: 9, ' ': 32 }

for (const step of JSON.parse(process.argv[2])) {
  if (step.eval) console.log(JSON.stringify(await evaluate(step.eval)))
  else if (step.fill) console.log('fill', JSON.stringify(await evaluate(setValue(step.fill[0], step.fill[1], 'input'))))
  else if (step.select) console.log('select', JSON.stringify(await evaluate(setValue(step.select[0], step.select[1], 'change'))))
  else if (step.click) console.log('click', JSON.stringify(await evaluate(click(step.click))))
  else if (step.waitFor) {
    const deadline = Date.now() + (step.ms ?? 30000)
    let ok = false
    while (Date.now() < deadline && !(ok = Boolean(await evaluate(step.waitFor)))) await new Promise((r) => setTimeout(r, 250))
    console.log('waitFor', ok ? 'ok' : 'TIMEOUT', step.waitFor.slice(0, 80))
    if (!ok) process.exitCode = 1
  } else if (step.shot) {
    const r = await call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(step.shot, Buffer.from(r.result.data, 'base64'))
    console.log('shot', step.shot)
  } else if (step.tap) {
    const { x, y } = await evaluate(centerOf(step.tap))
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await call('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
    console.log('tap', JSON.stringify(step.tap))
  } else if (step.press) {
    const code = KEYS[step.press] ?? 0
    for (const type of ['keyDown', 'keyUp'])
      await call('Input.dispatchKeyEvent', { type, key: step.press, code: step.press, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
    console.log('press', step.press)
  } else if (step.wait) await new Promise((r) => setTimeout(r, step.wait))
}
ws.close()
