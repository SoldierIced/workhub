/** The remote-access bridge for Settings: arguments are checked here; the renderer is not trusted with shapes. */
import type { IpcRegistrar } from '../ipc-guard'
import { isRemoteCapability, type RemoteCapability } from '../../shared/remote-api'
import type { RemoteService } from './service'

const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
const caps = (v: unknown): RemoteCapability[] => (Array.isArray(v) ? v.filter(isRemoteCapability) : [])

export function registerRemoteIpc(ipc: IpcRegistrar, service: RemoteService): void {
  ipc.handle('remote:status', () => service.status())
  ipc.handle('remote:setEnabled', (_e, enabled: unknown) => service.setEnabled(enabled === true))
  ipc.handle('remote:setRelayUrl', (_e, url: unknown) => service.setRelayUrl(typeof url === 'string' ? url.slice(0, 500) : ''))
  ipc.handle('remote:setDesktopName', (_e, name: unknown) => service.setDesktopName(typeof name === 'string' ? name : ''))
  ipc.handle('remote:startPairing', () => service.startPairing())
  ipc.handle('remote:cancelPairing', () => service.cancelPairing())
  ipc.handle('remote:acceptPairing', (_e, deviceId: unknown, capabilities: unknown) => {
    if (!isId(deviceId)) throw new Error('a device id is required')
    return service.acceptPairing(deviceId, caps(capabilities))
  })
  ipc.handle('remote:rejectPairing', (_e, deviceId: unknown) => {
    if (!isId(deviceId)) throw new Error('a device id is required')
    return service.rejectPairing(deviceId)
  })
  ipc.handle('remote:setCapabilities', (_e, deviceId: unknown, capabilities: unknown) => {
    if (!isId(deviceId)) throw new Error('a device id is required')
    return service.setCapabilities(deviceId, caps(capabilities))
  })
  ipc.handle('remote:revoke', (_e, deviceId: unknown) => {
    if (!isId(deviceId)) throw new Error('a device id is required')
    return service.revoke(deviceId)
  })
}
