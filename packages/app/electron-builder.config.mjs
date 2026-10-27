import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { BRAND } from '../../scripts/brand.mjs'

// The version of the release is the root package.json's; the app package follows it.
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

/**
 * macOS signing, as Workhub 1's bundle.sh does it: WORKHUB_SIGN_IDENTITY, else the first
 * "Apple Development" identity in the keychain, else ad hoc ("-"). Never notarized. A real
 * identity keeps the app's identity stable across builds, so macOS remembers its permissions.
 * Set WORKHUB_SIGN_IDENTITY=- to force ad hoc.
 */
function macIdentity() {
  if (process.env.WORKHUB_SIGN_IDENTITY) return process.env.WORKHUB_SIGN_IDENTITY
  if (process.platform !== 'darwin') return '-'
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
    return out.match(/"(Apple Development: [^"]*)"/)?.[1] ?? '-'
  } catch {
    return '-'
  }
}

/** @type {import('electron-builder').Configuration} */
export default {
  appId: BRAND.appId,
  productName: BRAND.productName,
  copyright: BRAND.copyright,
  // The build output lives at the repo root (git-ignored).
  directories: { output: '../../dist', buildResources: 'build' },
  // Only the bundled app and node-pty ship in app.asar: everything else is bundled by electron-vite,
  // and the Claude bridge goes to <resources>/bridge (scripts via extraResources, node_modules via
  // scripts/after-pack.mjs, because extraResources never copies node_modules).
  files: ['out/**', 'package.json', '!node_modules/**', 'node_modules/node-pty/**', '!node_modules/node-pty/{src,deps,scripts,typings,third_party}/**', '!**/*.{map,test.js}'],
  asarUnpack: ['node_modules/node-pty/**'],
  extraResources: [{ from: '.stage/bridge', to: 'bridge', filter: ['**/*'] }],
  extraMetadata: { name: BRAND.slug, productName: BRAND.productName, version, main: 'out/main/index.js' },
  afterPack: './scripts/after-pack.mjs',
  npmRebuild: true,
  artifactName: `${BRAND.productName.replace(/ /g, '-')}-\${version}-\${os}-\${arch}.\${ext}`,
  publish: { provider: 'github', owner: BRAND.repo.owner, repo: BRAND.repo.name, releaseType: 'prerelease' },
  mac: {
    category: 'public.app-category.developer-tools',
    target: [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }],
    identity: macIdentity(),
    // Hardened runtime needs a Developer ID + notarization; an unsigned build runs without it.
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false
  },
  dmg: { title: '${productName} ${version}' },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: true },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }],
    category: 'Development',
    executableName: BRAND.slug,
    maintainer: BRAND.repo.owner
  }
}
