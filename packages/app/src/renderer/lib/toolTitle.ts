import type { MessageKey, Params } from '../i18n/translate'

type Translate = (key: MessageKey, params?: Params) => string

const FIXED: Record<string, MessageKey> = {
  'Ran a command': 'monitor.tool.ranCommand',
  'Asked you a question': 'monitor.tool.askedQuestion',
  'Updated the task list': 'monitor.tool.updatedTasks',
  'Proposed a plan': 'monitor.tool.proposedPlan',
  'Ran code': 'monitor.tool.ranCode',
  'Read a file': 'monitor.tool.readFile',
  'Read files': 'monitor.tool.readFiles',
  'Edited a file': 'monitor.tool.editedFile',
  'Wrote a file': 'monitor.tool.wroteFile',
  'Deleted a file': 'monitor.tool.deletedFile',
  'Searched the code': 'monitor.tool.searchedCode',
  'Fetched a page': 'monitor.tool.fetchedPage',
  'Started a subagent': 'monitor.tool.startedSubagent'
}

// The adapters word a tool call in English ("Read README.md"); these patterns are the shapes they
// write. File-like arguments are a single word so a free-text title the model wrote ("Read the logs") is left alone.
const PATTERNS: readonly { re: RegExp; key: MessageKey; params: (m: RegExpExecArray) => Params }[] = [
  { re: /^Read (\S+)$/, key: 'monitor.tool.read', params: (m) => ({ name: m[1]! }) },
  { re: /^Edited (\S+)$/, key: 'monitor.tool.edited', params: (m) => ({ name: m[1]! }) },
  { re: /^Wrote (\S+)$/, key: 'monitor.tool.wrote', params: (m) => ({ name: m[1]! }) },
  { re: /^Deleted (\S+)$/, key: 'monitor.tool.deleted', params: (m) => ({ name: m[1]! }) },
  { re: /^Searched the code for "(.*)"$/, key: 'monitor.tool.searchedCodeFor', params: (m) => ({ query: m[1]! }) },
  { re: /^Searched the web for "(.*)"$/, key: 'monitor.tool.searchedWebFor', params: (m) => ({ query: m[1]! }) },
  { re: /^Searched for "(.*)"$/, key: 'monitor.tool.searchedFor', params: (m) => ({ query: m[1]! }) },
  { re: /^Listed files matching (.+)$/, key: 'monitor.tool.listedFiles', params: (m) => ({ pattern: m[1]! }) },
  { re: /^Started an? (\S+) subagent$/, key: 'monitor.tool.startedTyped', params: (m) => ({ kind: m[1]! }) },
  { re: /^Fetched (\S+)$/, key: 'monitor.tool.fetched', params: (m) => ({ host: m[1]! }) },
  { re: /^Loaded the (\S+) skill$/, key: 'monitor.tool.loadedSkill', params: (m) => ({ skill: m[1]! }) },
  { re: /^Called ([^:\s]+): (.+)$/, key: 'monitor.tool.called', params: (m) => ({ server: m[1]!, action: m[2]! }) }
]

/** A tool call's title in the UI language; titles that are not one of the adapters' shapes (a command's description) stay as they are. */
export function localizeToolTitle(title: string, t: Translate): string {
  const fixed = FIXED[title]
  if (fixed) return t(fixed)
  for (const p of PATTERNS) {
    const m = p.re.exec(title)
    if (m) return t(p.key, p.params(m))
  }
  return title
}
