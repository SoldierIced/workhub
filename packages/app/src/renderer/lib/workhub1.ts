import { useEffect, useState } from 'react'
import type { Workhub1Preview } from '@shared/api'

/**
 * Visibility rules of the Workhub 1 migration UI: it is only for people who used Workhub 1 on this
 * machine, so nothing shows until the preview says Workhub 1's settings are here.
 */

/** The "Migrate from Workhub 1" section: macOS, and Workhub 1's settings were found. */
export function showWorkhub1Migration(platform: string, preview: Workhub1Preview | null): boolean {
  return platform === 'mac' && preview?.available === true
}

/** The "Import tokens from Workhub 1" button: at least one connection from Workhub 1 still lacks its token. */
export function showWorkhub1Tokens(platform: string, preview: Workhub1Preview | null): boolean {
  return showWorkhub1Migration(platform, preview) && (preview?.pendingSecrets?.length ?? 0) > 0
}

/** Reads the Workhub 1 preview on macOS, again whenever `refreshKey` changes (the config was saved). */
export function useWorkhub1Preview(refreshKey: unknown): Workhub1Preview | null {
  const [preview, setPreview] = useState<Workhub1Preview | null>(null)
  useEffect(() => {
    if (window.hub.platform !== 'mac') return
    let alive = true
    window.hub.config
      .previewWorkhub1Import()
      .then((p) => alive && setPreview(p))
      .catch(() => alive && setPreview({ available: false }))
    return () => {
      alive = false
    }
  }, [refreshKey])
  return preview
}
