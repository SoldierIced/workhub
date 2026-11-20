#!/usr/bin/env node
/**
 * Builds the Linux host payload: the archive the app installs into a WSL distribution on first use
 * (packages/app/src/main/wsl-host-install.ts) and the release workflow attaches to every release.
 *
 * usage: stage-host.mjs [--arch x64|arm64] [--out dir]     default: this machine's arch, dist/host
 * needs: `npm run build -w @workhub/app` first (it reads packages/app/out/main/host.js).
 *
 * Writes <out>/workhub-host-<version>-linux-<arch>.tar.gz and its .sha256. At the archive's root:
 *   host.js and the chunks it loads   from the electron-vite main build (followed require by require)
 *   node_modules/node-pty             the one runtime dependency the build leaves external
 *   bridge/                           the Claude bridge staged for linux-<arch> (scripts/stage-bridge.mjs)
 *   node/                             the pinned Node.js of the managed tools, checksum-verified (no C headers)
 *   manifest.json                     {version, arch, node, createdFrom}
 *
 * node-pty is a native module with no published Linux prebuild: the payload takes the binary the
 * root `npm ci` compiled (scripts/postinstall.mjs), so it must be built on Linux, on the arch it
 * targets, and its binary needs a glibc at least as new as the build machine's. CI builds it on a
 * Linux runner per arch (.github/workflows/release.yml).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const arch = opt('arch', process.arch)
const out = resolve(opt('out', join(root, 'dist', 'host')))

const fail = (message) => {
  console.error(`stage-host: ${message}`)
  process.exit(1)
}
if (arch !== 'x64' && arch !== 'arm64') fail(`--arch must be x64 or arm64, not ${arch}`)
if (process.platform !== 'linux' || process.arch !== arch) {
  fail(`the linux-${arch} payload must be built on linux-${arch} (node-pty is native and not cross-built); this is ${process.platform}-${process.arch}`)
}

// The payload names, the manifest and the pinned Node download live in core (TypeScript): bundle the
// few exports this needs, rather than copying the versions and checksum handling here.
const core = await (async () => {
  const result = await build({
    stdin: {
      contents: [
        "export { MANAGED_TOOLS, managedDownload, checksumFor, downloadFileName } from './packages/core/src/setup/managed-tools'",
        "export { hostPayloadName, hostPayloadManifest } from './packages/core/src/host/payload'"
      ].join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent'
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
})()

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const name = core.hostPayloadName(version, arch)
const mainOut = join(root, 'packages', 'app', 'out', 'main')
if (!existsSync(join(mainOut, 'host.js'))) fail('packages/app/out/main/host.js is missing: run `npm run build -w @workhub/app` first')

const stage = join(out, `.stage-linux-${arch}`)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// 1. host.js and every chunk it loads, at the same paths relative to each other.
const nodeBuiltin = (id) => id.startsWith('node:')
/** The packages the main build leaves external that the host loads at runtime, and that ship in the payload. */
const shippedExternals = new Set(['node-pty'])
const externals = new Set()
const copied = new Set()
const follow = (file) => {
  if (copied.has(file)) return
  copied.add(file)
  const dest = join(stage, relative(mainOut, file))
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(file, dest)
  for (const [, id] of readFileSync(file, 'utf8').matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    if (id.startsWith('.')) follow(resolve(dirname(file), id))
    else if (!nodeBuiltin(id)) externals.add(id)
  }
}
follow(join(mainOut, 'host.js'))
const unknown = [...externals].filter((id) => !shippedExternals.has(id))
if (unknown.length > 0) fail(`host.js requires packages the payload does not ship: ${unknown.join(', ')} (bundle them, or add them here)`)
console.log(`host: ${[...copied].map((f) => relative(mainOut, f)).join(', ')}`)

// 2. node-pty: its JavaScript and the binary the root install compiled for this machine.
const pty = join(root, 'node_modules', 'node-pty')
const ptyBinary = join(pty, 'build', 'Release', 'pty.node')
if (!existsSync(ptyBinary)) fail(`${relative(root, ptyBinary)} is missing: run \`npm ci\` on linux-${arch} first`)
const ptyDest = join(stage, 'node_modules', 'node-pty')
cpSync(join(pty, 'package.json'), join(ptyDest, 'package.json'))
cpSync(join(pty, 'LICENSE'), join(ptyDest, 'LICENSE'))
cpSync(join(pty, 'lib'), join(ptyDest, 'lib'), { recursive: true, filter: (src) => !/\.(map|test\.js)$/.test(src) })
cpSync(ptyBinary, join(ptyDest, 'build', 'Release', 'pty.node'))

// 3. The Claude bridge for linux-<arch> (the SDK's native `claude` and claude-agent-acp included).
execFileSync(process.execPath, [join(root, 'scripts', 'stage-bridge.mjs'), '--platform', 'linux', '--arch', arch, '--out', join(stage, 'bridge')], { stdio: 'inherit' })
// npm installs the musl twin of the native package too (about 280 MB). The payload is glibc only:
// its Node.js and node-pty need glibc, so a musl distribution (Alpine) could not run it anyway.
rmSync(join(stage, 'bridge', 'node_modules', '@anthropic-ai', `claude-agent-sdk-linux-${arch}-musl`), { recursive: true, force: true })

// 4. Node.js: the managed tools' pinned linux archive, checked against the published SHASUMS256.txt.
const nodeDownload = core.managedDownload('node', 'linux', arch)
if (!nodeDownload || !('list' in nodeDownload.checksum)) fail(`no pinned Node.js download for linux-${arch}`)
const nodeFile = core.downloadFileName(nodeDownload.url)
const cache = join(out, '.cache')
mkdirSync(cache, { recursive: true })
const sha256File = async (file) => {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}
const listRes = await fetch(nodeDownload.checksum.list)
if (!listRes.ok) fail(`${nodeDownload.checksum.list}: HTTP ${listRes.status}`)
const expectedNode = core.checksumFor(await listRes.text(), nodeFile)
if (!expectedNode) fail(`${nodeFile} is not in ${nodeDownload.checksum.list}`)
const nodeArchive = join(cache, nodeFile)
if (!existsSync(nodeArchive) || (await sha256File(nodeArchive)) !== expectedNode) {
  console.log(`downloading ${nodeDownload.url}`)
  const res = await fetch(nodeDownload.url)
  if (!res.ok || !res.body) fail(`${nodeDownload.url}: HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${nodeArchive}.partial`))
  if ((await sha256File(`${nodeArchive}.partial`)) !== expectedNode) {
    rmSync(`${nodeArchive}.partial`, { force: true })
    fail(`${nodeFile} does not match its published SHA-256`)
  }
  renameSync(`${nodeArchive}.partial`, nodeArchive)
}
mkdirSync(join(stage, 'node'))
execFileSync('tar', ['-xzf', nodeArchive, '-C', join(stage, 'node'), '--strip-components=1'], { stdio: 'inherit' })
// The C headers are for compiling addons, which nothing does inside the payload (65 MB unpacked).
rmSync(join(stage, 'node', 'include'), { recursive: true, force: true })
const nodeBin = join(stage, 'node', 'bin', 'node')

// 5. The manifest, then a check that the staged Node runs the staged host and loads node-pty.
const commit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
})()
const manifest = core.hostPayloadManifest({ version, arch, node: core.MANAGED_TOOLS.node.version, commit })
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
const said = execFileSync(nodeBin, [join(stage, 'host.js'), '--version', '--host-version', version], { encoding: 'utf8' }).trim()
if (said !== version) fail(`the staged host printed ${JSON.stringify(said)} for --version, not ${version}`)
execFileSync(nodeBin, ['-e', "require('./node_modules/node-pty')"], { cwd: stage, stdio: 'inherit' })

// 6. The archive (entries in a fixed order, owned by root, dated by the commit) and its checksum.
const mtime = (() => {
  try {
    return `@${execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' }).trim()}`
  } catch {
    return '@0'
  }
})()
const archive = join(out, name)
execFileSync('tar', ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', `--mtime=${mtime}`, '-czf', archive, '-C', stage, ...readdirSync(stage).sort()], { stdio: 'inherit' })
writeFileSync(`${archive}.sha256`, `${await sha256File(archive)}  ${name}\n`)
rmSync(stage, { recursive: true, force: true })
console.log(`${archive} (${(statSync(archive).size / 1024 / 1024).toFixed(1)} MiB)`)
