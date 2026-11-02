/** The metric alerts bridge: list a profile's alerts, act on one, evaluate now. Arguments are checked here; the renderer is not trusted with shapes. */
import { isAlertAction } from '@workhub/core'
import type { MetricAlertsView } from '../shared/metric-alerts-api'
import type { IpcRegistrar } from './ipc-guard'
import type { MetricAlertService } from './metric-alerts'

const EMPTY: MetricAlertsView = { enabled: false, demo: false, alerts: [] }
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 500

export function registerMetricAlertsIpc(ipc: IpcRegistrar, service: Pick<MetricAlertService, 'list' | 'setStatus' | 'refresh'>): void {
  ipc.handle('metricAlerts:list', (_e, profileId: unknown) => (isId(profileId) ? service.list(profileId) : EMPTY))
  ipc.handle('metricAlerts:setStatus', (_e, profileId: unknown, key: unknown, action: unknown) => {
    if (!isId(profileId) || !isId(key) || !isAlertAction(action)) throw new Error('Invalid alert action')
    return service.setStatus(profileId, key, action)
  })
  ipc.handle('metricAlerts:refresh', (_e, profileId: unknown) => (isId(profileId) ? service.refresh(profileId) : EMPTY))
}
