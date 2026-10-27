import { useEffect, useState } from 'react'
import type { FolderSpendResult } from '@shared/api'

/**
 * Token spend per folder of a profile, as the main process last scanned it. Ready on mount from
 * the cached scan; asked again when a background scan ends and when the profile changes.
 * Null until the first answer.
 */
export function useFolderSpend(profileId: string | null | undefined): FolderSpendResult | null {
  const [spend, setSpend] = useState<FolderSpendResult | null>(null)
  useEffect(() => {
    let live = true
    setSpend(null)
    const read = () =>
      void window.hub.usage.folderSpend(profileId ?? null).then(
        (s) => live && setSpend(s),
        () => {}
      )
    read()
    const off = window.hub.usage.onFolderSpendChanged(read)
    return () => {
      live = false
      off()
    }
  }, [profileId])
  return spend
}
