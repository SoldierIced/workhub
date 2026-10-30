// Types of the Flow maps bridge (window.hub.flowMaps): the files of the data folder and the map window.
export type FlowMapImportResult = { file: string; ok: true; id: string } | { file: string; ok: false; errors: string[] }

export interface FlowMapsApi {
  /** The folder the map files live in (`<data folder>/flow-maps`); created when asked for. */
  folder(): Promise<string>
  /** Shows the folder in the file manager. */
  reveal(): void
  /** Asks for JSON files, validates each and stores the good ones under their id; one result per file picked. */
  importFiles(): Promise<FlowMapImportResult[]>
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
