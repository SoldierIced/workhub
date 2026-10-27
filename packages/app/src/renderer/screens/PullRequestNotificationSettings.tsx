import { appOptions, PR_EVENT_KINDS, type Result, type WorkhubConfig } from '@workhub/core'
import { Switch } from '../components/atoms'
import { SwitchRow } from '../components/molecules'
import { useI18n } from '../i18n/I18nProvider'
import { PR_KIND_HINT, PR_KIND_LABEL } from '../lib/prEvents'

/** The rows of Settings → Notifications for pull request events: one switch per kind. */
export function PullRequestNotificationRows({
  config,
  editable,
  run
}: {
  config: WorkhubConfig
  editable: boolean
  run: (op: () => Promise<Result<WorkhubConfig>>) => Promise<boolean>
}) {
  const { t } = useI18n()
  const toggles = appOptions(config).notifyPrEvents
  return (
    <>
      {PR_EVENT_KINDS.map((kind) => (
        <SwitchRow key={kind} label={t(PR_KIND_LABEL[kind])} hint={t(PR_KIND_HINT[kind])}>
          <Switch checked={toggles[kind]} disabled={!editable} onChange={(on) => void run(() => window.hub.config.saveOptions({ notifyPrEvents: { ...toggles, [kind]: on } }))} />
        </SwitchRow>
      ))}
    </>
  )
}
