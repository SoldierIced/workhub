import { describe, expect, it } from 'vitest'
import {
  folderForEvent,
  folderForPod,
  investigationTargets,
  involvedRepositories,
  isSystemContainer,
  itemId,
  matchFolder,
  podStatusHeadline,
  pruneSelection,
  selectableItems,
  selectedSignals,
  serviceOfPod,
  sharedFolder,
  signalCount,
  toggleItem,
  windowVerdict,
  workloadName,
  type HealthSnapshot,
  type TrendStats
} from '../src'

const stats: TrendStats = { recent: 5, typicalDay: 1, streakDays: 2, streakTruncated: false, daysWithData: 14, state: 'worsening' }
const snapshot: Pick<HealthSnapshot, 'errorServices' | 'silentServices' | 'pods' | 'events' | 'slow'> = {
  errorServices: [{ service: 'orders-api', stats }],
  silentServices: [{ service: 'report-batch', lastSeen: 0, silentMinutes: 90, isReporting: false }],
  pods: [{ pod: 'orders-api-7f9c5d-xk2lp', notReady: true, restarts: 0, recentRestarts: 0, backOff: false, kind: 'notReady' }],
  events: [{ reason: 'BackOff', stats, object: 'ledger-0' }],
  slow: [{ service: 'orders-api', name: 'POST /orders', calls: 10, p50Ms: 1, p95Ms: 2, p99Ms: 3, failureRate: 0 }]
}
const folders = ['/src/orders-api', '/src/Ledger', '/src/web']

describe('health selection', () => {
  it('offers every row in screen order and toggles them', () => {
    const all = selectableItems(snapshot)
    expect(all).toEqual(['errors:orders-api', 'pod:orders-api-7f9c5d-xk2lp', 'event:BackOff', 'silent:report-batch', 'flow:orders-api|POST /orders'])
    let selection = toggleItem(new Set(), all[0]!)
    selection = toggleItem(selection, all[4]!)
    expect([...selection]).toEqual(['errors:orders-api', 'flow:orders-api|POST /orders'])
    expect([...toggleItem(selection, all[0]!)]).toEqual(['flow:orders-api|POST /orders'])
  })

  it('drops rows a refresh removed, and keeps the same set when nothing changed', () => {
    const selection = new Set([itemId('errors', 'orders-api'), itemId('pod', 'gone')])
    expect([...pruneSelection(selection, selectableItems(snapshot))]).toEqual(['errors:orders-api'])
    const kept = new Set([itemId('errors', 'orders-api')])
    expect(pruneSelection(kept, selectableItems(snapshot))).toBe(kept)
  })

  it('resolves the selection against the snapshot', () => {
    const s = selectedSignals(new Set(selectableItems(snapshot)), snapshot)
    expect(signalCount(s)).toBe(5)
    expect(signalCount(selectedSignals(new Set(['event:Nope']), snapshot))).toBe(0)
  })
})

describe('repository folders', () => {
  it('matches a service by folder name, case and separators ignored', () => {
    expect(matchFolder(folders, 'ORDERS_API')).toBe('/src/orders-api')
    expect(matchFolder(folders, 'payments')).toBeUndefined()
    expect(matchFolder(folders, '')).toBeUndefined()
  })

  it('names the workload of a pod and finds its folder', () => {
    expect(workloadName('orders-api-7f9c5d-xk2lp')).toBe('orders-api')
    expect(workloadName('ledger-0')).toBe('ledger')
    expect(workloadName('report-batch-28465-abcde')).toBe('report-batch-28465-abcde')
    expect(workloadName('report-batch-28465')).toBe('report-batch')
    expect(serviceOfPod('x-1', 'api')).toBe('api')
    expect(folderForPod(folders, 'orders-api-7f9c5d-xk2lp')).toBe('/src/orders-api')
    expect(folderForPod(folders, 'web-worker-abc', undefined)).toBe('/src/web')
    expect(folderForPod(folders, 'x-7f9c5d', 'Ledger')).toBe('/src/Ledger')
    expect(folderForEvent(folders, { object: 'ledger-0' })).toBe('/src/Ledger')
    expect(folderForEvent(folders, {})).toBeUndefined()
  })

  it('opens in the one shared folder, else lists the repositories involved', () => {
    const one = investigationTargets(selectedSignals(new Set(['errors:orders-api', 'flow:orders-api|POST /orders', 'pod:orders-api-7f9c5d-xk2lp']), snapshot), folders)
    expect(sharedFolder(one)).toBe('/src/orders-api')
    const many = investigationTargets(selectedSignals(new Set(selectableItems(snapshot)), snapshot), folders)
    expect(sharedFolder(many)).toBeUndefined()
    expect(involvedRepositories(many)).toEqual({ repositories: ['orders-api', 'Ledger'], unmatched: ['report-batch'] })
    expect(sharedFolder([])).toBeUndefined()
  })
})

describe('health details helpers', () => {
  it('tells system containers apart by name or namespace', () => {
    expect(isSystemContainer('ebs-csi-node')).toBe(true)
    expect(isSystemContainer('orders-api', 'kube-system')).toBe(true)
    expect(isSystemContainer('orders-api', 'shop')).toBe(false)
    expect(isSystemContainer('csiapp')).toBe(false)
  })

  it('picks the pod status headline', () => {
    expect(podStatusHeadline({ waitingReason: 'CrashLoopBackOff', lastTerminatedReason: 'OOMKilled' })).toBe('CrashLoopBackOff')
    expect(podStatusHeadline({ lastTerminatedReason: 'Completed' })).toBeUndefined()
    expect(podStatusHeadline({ lastTerminatedReason: 'Error' })).toBe('Error')
  })

  it('judges a window comparison', () => {
    const w = (errors: number, transactions: number, failed: number, p95?: number) => ({ errors, transactions, failedTransactions: failed, p95Ms: p95 })
    const base = { service: 's', transaction: null, windowHours: 24, newErrorTypes: [] }
    expect(windowVerdict({ ...base, previous: w(0, 0, 0), current: w(0, 0, 0) })).toEqual({ kind: 'noSignal' })
    expect(windowVerdict({ ...base, previous: w(2, 100, 0, 100), current: w(5, 100, 1, 140) })).toEqual({ kind: 'clean' })
    // 4 ms -> 9 ms doubles but is not a regression.
    expect(windowVerdict({ ...base, previous: w(0, 100, 0, 4), current: w(0, 100, 0, 9) })).toEqual({ kind: 'clean' })
    expect(windowVerdict({ ...base, previous: w(0, 100, 0, 400), current: w(0, 100, 0, 700) })).toEqual({ kind: 'regressed', reasons: [{ code: 'latency', before: 400, after: 700 }] })
  })
})
