import type { AlertRuleKind, MetricAlert } from '../alerts/types'
import type { InboxProposal, InboxSource } from './types'

const RULE_NAME: Record<AlertRuleKind, string> = {
  jump: 'sudden jump',
  rateDrop: 'rate drop',
  sustainedTrend: 'sustained trend',
  newSubject: 'new subject',
  missingData: 'missing data'
}

const signed = (n: number, unit: string) => `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10}${unit}`

/** A pending bug for a metric alert ("Send to inbox"): the metric, subject, values, period and link. */
export function alertInboxProposal(alert: MetricAlert): { proposal: InboxProposal; source: InboxSource } {
  const metric = alert.label || alert.metric
  const where = alert.segment ? `${alert.subject} (${alert.segment})` : alert.subject
  const change = alert.changePct !== undefined ? signed(alert.changePct, ' %') : alert.changePoints !== undefined ? signed(alert.changePoints, ' points') : null
  const period = alert.firstSeenDay === alert.lastSeenDay ? alert.lastSeenDay : `${alert.firstSeenDay} to ${alert.lastSeenDay}`
  const detail = [
    `Metric: ${metric}`,
    `Subject: ${where}`,
    `Rule: ${RULE_NAME[alert.kind]} (${alert.severity} severity)`,
    `Value: ${alert.lastValue} (baseline ${alert.baseline}${change ? `, ${change}` : ''})`,
    `Period: ${period}`,
    ...(alert.link ? [`Link: ${alert.link}`] : [])
  ].join('\n')
  return {
    proposal: { kind: 'bug', title: `${metric}: ${RULE_NAME[alert.kind]} on ${where}`.slice(0, 300), detail, ...(alert.link ? { link: alert.link } : {}) },
    source: { type: 'alert', ref: alert.key, label: metric }
  }
}
