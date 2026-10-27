import type { HubApi } from '@shared/api'

declare global {
  interface Window {
    hub: HubApi
  }
}
