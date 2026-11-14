import type { IpcRegistrar } from './ipc-guard'
import type { InstallResult } from './setup-install'

export interface SetupInstallIpcDeps {
  /** Installs from the installer table; the renderer only names the installer. */
  install: (installer: unknown) => Promise<InstallResult>
}

export function registerSetupInstallIpc(ipc: IpcRegistrar, deps: SetupInstallIpcDeps): void {
  ipc.handle('setup:install', (_e, installer: unknown) => deps.install(installer))
}
