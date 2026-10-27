/**
 * What an agent's terminal UI is doing, read from the escape sequences it prints. Claude Code
 * titles the terminal with a spinner while a turn runs and with ✳ while it waits at its prompt;
 * it posts a desktop notification (OSC 9 or OSC 777) when it needs a permission or an answer.
 * Workhub 1 reads the same signals (Console.isTurnInProgress).
 */

/** Braille spinner frames, and the quarter circles some versions use. */
export function isSpinner(title: string): boolean {
  const code = title.codePointAt(0)
  if (code === undefined) return false
  return (code >= 0x2800 && code <= 0x28ff) || (code >= 0x25d0 && code <= 0x25d3)
}

/** Whether a notification asks the user to act (a permission prompt or a question). */
export function asksForAction(text: string): boolean {
  const t = text.toLowerCase()
  return t.includes('needs your permission') || t.includes('has a question')
}

// OSC <code> ; <payload> terminated by BEL or ST (ESC \).
const OSC = /\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g
/** Longest unterminated OSC kept between chunks (titles and notifications are short). */
const MAX_CARRY = 1024

export class ConsoleActivity {
  /** The last title the agent set; empty until it sets one. */
  title = ''
  /** A notification asked the user to act and nothing answered it yet. */
  asking = false
  private carry = ''

  /** Reads one chunk of output. Returns true when the title or the asking flag changed. */
  feed(data: string): boolean {
    const text = this.carry + data
    this.carry = ''
    const before = `${this.title}\u0000${this.asking}`
    let end = 0
    for (const m of text.matchAll(OSC)) {
      end = m.index + m[0].length
      const code = m[1]
      const payload = m[2] ?? ''
      if (code === '0' || code === '2') {
        this.title = payload
        // Work resumed: whatever was asked has been answered.
        if (isSpinner(payload)) this.asking = false
      } else if (code === '9' && asksForAction(payload)) {
        this.asking = true
      } else if (code === '777' && payload.startsWith('notify;') && asksForAction(payload.slice('notify;'.length))) {
        this.asking = true
      }
    }
    // An OSC split across chunks: keep its start for the next one.
    const open = text.lastIndexOf('\x1b]')
    if (open >= end && text.length - open <= MAX_CARRY) this.carry = text.slice(open)
    return `${this.title}\u0000${this.asking}` !== before
  }

  /** The user typed into the terminal: an open question is being answered there. */
  typed(): void {
    this.asking = false
  }

  /** Whether handing the conversation over now would cut a turn off. */
  get busy(): boolean {
    return isSpinner(this.title) || this.asking
  }

  reset(): void {
    this.title = ''
    this.asking = false
    this.carry = ''
  }
}
