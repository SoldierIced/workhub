// Entry point. Configuration by environment:
//   PORT               listen port (default 8787)
//   HOST               bind address (default 0.0.0.0)
//   WEB_CLIENT_DIR     built web client to serve (optional)
//   DATA_DIR           where push subscriptions persist (default ./data)
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   enable Web Push (all three, or none)
//   PUSH_ENDPOINT_HOSTS  extra push-service hosts, comma separated (browsers' are built in)
//   TRUST_PROXY        "1" behind a reverse proxy that sets X-Real-IP / X-Forwarded-For (default off)
//   RELAY_VERSION      reported by /healthz
import { join } from 'node:path'
import { createRelayServer } from './server'
import { FilePushStore } from './push-store'
import { generateVapidKeys, WebPushProvider } from './push'

const env = process.env
if (process.argv.includes('--vapid')) {
  const keys = generateVapidKeys()
  console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}`)
  process.exit(0)
}

const port = Number(env['PORT'] ?? 8787)
const host = env['HOST'] ?? '0.0.0.0'
const dataDir = env['DATA_DIR'] ?? join(process.cwd(), 'data')
const vapid = env['VAPID_PUBLIC_KEY'] && env['VAPID_PRIVATE_KEY'] && env['VAPID_SUBJECT'] ? { publicKey: env['VAPID_PUBLIC_KEY'], privateKey: env['VAPID_PRIVATE_KEY'], subject: env['VAPID_SUBJECT'] } : null

const log = {
  info: (line: string) => console.log(`${new Date().toISOString()} ${line}`),
  warn: (line: string) => console.warn(`${new Date().toISOString()} warn ${line}`)
}

const pushStore = new FilePushStore(join(dataDir, 'push-subscriptions.json'))
const server = createRelayServer({
  push: vapid ? new WebPushProvider(vapid, { extraHosts: (env['PUSH_ENDPOINT_HOSTS'] ?? '').split(',') }) : undefined,
  pushStore,
  webClientDir: env['WEB_CLIENT_DIR'] || undefined,
  trustProxy: env['TRUST_PROXY'] === '1',
  version: env['RELAY_VERSION'] ?? 'dev',
  log
})

server.http.listen(port, host, () => {
  log.info(`workhub relay listening on ${host}:${port}; push ${vapid ? 'on' : 'off'}; web client ${env['WEB_CLIENT_DIR'] ? 'served' : 'not served'}`)
})

const stop = () => {
  log.info('shutting down')
  try {
    pushStore.flush()
  } catch (err) {
    log.warn(`push store write failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  void server.close().then(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
