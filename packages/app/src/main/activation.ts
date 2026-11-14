/**
 * What macOS's `activate` (Cmd+Tab, a Dock click) brings up. With a window on screen (Settings, a
 * session window) macOS already brings back the last one used, so Workhub leaves it alone: always
 * showing the main window there would cover that window and steal its focus. With none visible
 * (the main window closed to the menu bar) the main window comes back.
 */
export function showMainOnActivate(hasVisibleWindows: boolean): boolean {
  return !hasVisibleWindows
}
