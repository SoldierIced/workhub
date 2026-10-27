import { useEffect, useState } from 'react'
import type { AccountUsage } from '@shared/api'

/** Plan usage read per Claude account; empty while the option is off (Settings → General). */
export function useAccountUsage(): AccountUsage[] {
  const [usage, setUsage] = useState<AccountUsage[]>([])
  useEffect(() => {
    void window.hub.usage.get().then(setUsage)
    return window.hub.usage.onChanged(setUsage)
  }, [])
  return usage
}
