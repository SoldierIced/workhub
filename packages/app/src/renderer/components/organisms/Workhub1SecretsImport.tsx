import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import type { Workhub1SecretResult } from '@workhub/core'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { refreshConfig } from '../../configStore'
import { Button } from '../atoms/Button'
import { Spinner } from '../atoms/Spinner'

const STATUS_LABEL: Record<Workhub1SecretResult['status'], MessageKey> = {
  imported: 'import.secretsImported',
  notFound: 'import.secretsNotFound',
  denied: 'import.secretsDenied',
  error: 'import.secretsError'
}

/**
 * macOS: copies the tokens Workhub 1 keeps in the Keychain into Workhub 2's secret store. macOS asks
 * the user to allow the access; only a status per connection comes back, never a secret.
 */
export function Workhub1SecretsImport({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Workhub1SecretResult[] | null>(null)
  if (window.hub.platform !== 'mac') return null

  const run = async () => {
    setBusy(true)
    try {
      setResults(await window.hub.config.importWorkhub1Secrets())
      await refreshConfig()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid="workhub1-secrets-import">
      <div className="flex items-center gap-3">
        {!compact && <p className="min-w-0 flex-1 text-xs text-subtle">{t('import.secretsHint')}</p>}
        <Button size="sm" variant="secondary" icon={busy ? <Spinner className="size-3" /> : <KeyRound className="size-3.5" aria-hidden />} disabled={busy} title={compact ? t('import.secretsHint') : undefined} onClick={() => void run()}>
          {t('import.secrets')}
        </Button>
      </div>
      {results && (
        <ul className="flex flex-col gap-1 text-sm" aria-live="polite" data-testid="workhub1-secrets-results">
          {results.length === 0 && <li className="text-muted">{t('import.secretsNone')}</li>}
          {results.map((r) => (
            <li key={r.connectionId} className={r.status === 'imported' ? 'text-success' : r.status === 'notFound' ? 'text-muted' : 'text-danger'}>
              <span className="font-medium">{r.name}</span>: {t(STATUS_LABEL[r.status], { code: r.code ?? '' })}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
