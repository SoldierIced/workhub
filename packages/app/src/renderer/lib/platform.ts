import type { Platform } from '@shared/api'

/** The OS family, from the preload bridge; constant for the life of the window. */
export function usePlatform(): Platform {
  return window.hub.platform
}
