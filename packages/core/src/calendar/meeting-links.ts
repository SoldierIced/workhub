/** Video call links calendars put in an event's location, URL or description. */
const MEETING_LINKS: readonly RegExp[] = [
  /https:\/\/meet\.google\.com\/[a-z0-9-]+(?:\?[^\s<>"'()]*)?/i,
  /https:\/\/(?:[\w-]+\.)?zoom\.us\/(?:j|my|w|s)\/[^\s<>"'()]+/i,
  /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"'()]+/i,
  /https:\/\/teams\.live\.com\/meet\/[^\s<>"'()]+/i,
  /https:\/\/[\w-]+\.webex\.com\/[^\s<>"'()]+/i,
  /https:\/\/whereby\.com\/[^\s<>"'()]+/i,
  /https:\/\/meet\.jit\.si\/[^\s<>"'()]+/i,
  /https:\/\/chime\.aws\/\d+/i,
  /https:\/\/app\.slack\.com\/huddle\/[^\s<>"'()]+/i
]

/** The first video call link in the texts, in the order given; undefined when there is none. */
export function findMeetingUrl(texts: readonly (string | undefined)[]): string | undefined {
  for (const text of texts) {
    if (!text) continue
    for (const pattern of MEETING_LINKS) {
      const m = pattern.exec(text)
      if (m) return m[0].replace(/[.,;>]+$/, '')
    }
  }
  return undefined
}
