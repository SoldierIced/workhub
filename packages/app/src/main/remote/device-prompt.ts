import type { ImageInput } from '@workhub/core'

export interface DevicePromptDeps {
  prompt(id: string, text: string, images: ImageInput[] | undefined, options: { onStart: () => void }): Promise<string>
  /** Shows the prompt as the user's message in the desktop windows' chat. */
  showPrompt(id: string, text: string): void
  /** Shows the end of its turn there, as for a prompt typed in the window. */
  showTurnEnd(id: string, stopReason: string): void
}

/**
 * A prompt a paired device sent. The device shows its own bubble; the desktop windows only learn
 * of it here, so the message is in the session's chat when the person is back at the computer.
 * The bubble goes in when the prompt actually goes out (it may wait behind another one).
 */
export async function promptFromDevice(deps: DevicePromptDeps, id: string, text: string, images?: ImageInput[]): Promise<string> {
  let started = false
  const stopReason = await deps.prompt(id, text, images, {
    onStart: () => {
      started = true
      deps.showPrompt(id, text)
    }
  })
  if (started) deps.showTurnEnd(id, stopReason)
  return stopReason
}
