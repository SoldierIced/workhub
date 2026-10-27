import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * electron-builder never copies a node_modules folder through extraResources, and the Claude bridge
 * needs its own (Agent SDK, its native `claude` binary, the ACP adapter). Copy it into
 * <resources>/bridge after the app is laid out and before it is signed.
 */
export default async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context
  const resources =
    electronPlatformName === 'darwin'
      ? join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(appOutDir, 'resources')
  const from = join(packager.projectDir, '.stage', 'bridge', 'node_modules')
  if (!existsSync(from)) throw new Error(`bridge not staged: run scripts/stage-bridge.mjs first (${from})`)
  cpSync(from, join(resources, 'bridge', 'node_modules'), { recursive: true, verbatimSymlinks: true })
}
