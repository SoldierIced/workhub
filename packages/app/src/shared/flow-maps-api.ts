import type { FlowMap, FlowMapAlerts } from '@workhub/core'

// Types of the Flow maps bridge (window.hub.flowMaps): the files of the data folder and the map window.
export type FlowMapImportResult = { file: string; ok: true; id: string } | { file: string; ok: false; errors: string[] }

/** The answer to `setAlerts`: the file written, or the problems that kept it from being written. */
export type FlowMapSetAlertsResult = { ok: true; file: string; id: string } | { ok: false; errors: string[] }

export interface FlowMapsApi {
  /** The folder the map files live in (`<data folder>/flow-maps`); created when asked for. */
  folder(): Promise<string>
  /** Shows the folder in the file manager. */
  reveal(): void
  /** Asks for JSON files, validates each and stores the good ones under their id; one result per file picked. */
  importFiles(): Promise<FlowMapImportResult[]>
  /** One map of the folder as it was validated (defaults filled); null when there is none with that id or its file is invalid. */
  get(mapId: string): Promise<FlowMap | null>
  /**
   * Writes a map's limits (`alerts`; null removes them) into its file (Settings → Alerts). The map is
   * validated first, and the rest of the file is kept byte for byte. Maps are shared by every
   * profile; `profileId` says who asked.
   */
  setAlerts(profileId: string | null, mapId: string, alerts: FlowMapAlerts | null): Promise<FlowMapSetAlertsResult>
  /** Deletes a map's file by id. */
  remove(id: string): Promise<boolean>
  /** Opens a map in a window of its own. */
  openWindow(profileId: string | null, environmentId: string, mapId: string): void
  /** Puts a PNG (a data URL) on the clipboard. */
  copyImage(dataUrl: string): Promise<boolean>
  /** From a map window: asks the main window to draft a Claude session with this text (see `onAsk`). */
  ask(draft: string, folder?: string): void
  /** Main window only: a map window asked for a session. */
  onAsk(cb: (draft: string, folder: string | undefined) => void): () => void
}
