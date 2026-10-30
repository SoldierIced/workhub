import type { ReviewFinding, ReviewLanguage, ReviewSeverity } from './types'
import { BLOCKING_SEVERITIES, REVIEW_SEVERITIES } from './types'

/** Everything the reviewer gets in one round. */
export interface ReviewPromptInput {
  language: ReviewLanguage
  round: number
  maxRounds: number
  branch: string
  /** Base branch name and the ref the diff is taken against. */
  base: string
  baseRef: string
  headSha: string
  mergeBase: string
  /** Round 2+: the HEAD reviewed last time; the delta below starts there. */
  fromSha?: string
  /** `<short sha> <subject>`, oldest first. */
  commits: string[]
  diffStat: string
  /**
   * Path, relative to the reviewer's folder, of the file holding the diff. The diff is never put
   * in the prompt: the reviewer reads it (and the code around it) from the folder.
   */
  diffFile: string
  /** The diff file was cut at a size limit; the reviewer must read the files themselves. */
  diffTruncated: boolean
  ticket?: { key: string; title?: string }
  checklist: string
  /** Paths with uncommitted changes in the dev's working tree (not part of the review). */
  uncommitted: string[]
  /** Round 2+: findings to verify (open or disputed). */
  previous: ReviewFinding[]
  userNotes: string[]
}

interface PromptStrings {
  intro: string
  intro2: string
  readOnly: string
  context: string
  ticket: string
  ticketNoTitle: string
  noTicket: string
  commits: string
  stat: string
  diff: string
  diffDelta: string
  truncated: string
  uncommitted: string
  previous: string
  userNotes: string
  checklistTitle: string
  checklist: string[]
  extraChecklist: string
  severities: string
  scope: string
  output: string
  /** The language the whole reply must be written in. */
  language: string
}

/** The reviewer prompt per language; English is the default. Placeholders are `{name}`. */
export const REVIEW_PROMPT_STRINGS: Record<ReviewLanguage, PromptStrings> = {
  en: {
    intro:
      'You are the code reviewer of branch `{branch}`, which will be opened as a pull request into `{base}`. This is review round {round} of at most {maxRounds}. The team wants ONE exhaustive pass: report everything you find now, so the author does not get a new batch of comments on every round. Be precise and concrete; do not pad the list.',
    intro2:
      'Round {round}: the author pushed new commits after your last review. Review the delta since `{fromSha}` (below), re-check the whole branch where the delta touches it, and verify each previous finding listed below: say whether it is fixed or still open. Report only genuinely new issues as new findings.',
    readOnly:
      'This folder is a read-only checkout of the branch at `{headSha}`. Read any file you need, but do not edit files, run commands that change anything, commit or push. Your only output is the review.',
    context: 'Merge base with `{baseRef}`: `{mergeBase}`.',
    ticket: 'Ticket: {key} "{title}". Check the change against what the ticket asks for.',
    ticketNoTitle: 'Ticket: {key}. Check the change against what the ticket asks for.',
    noTicket: 'No ticket is linked: infer the intent from the commits and the code.',
    commits: 'Commits on the branch:',
    stat: 'Files changed:',
    diff: 'The changes to review are in `{diffFile}`, in this folder: the output of `git diff {mergeBase}..{headSha}`. Read it first, then read the changed files and the code around them here for context. That file is not part of the branch: do not review it.',
    diffDelta: 'The changes since your last review are in `{diffFile}`, in this folder: the output of `git diff {fromSha}..{headSha}`. Read it first, then read the changed files and the code around them here for context. That file is not part of the branch: do not review it.',
    truncated: 'That diff file was cut at a size limit. Read the remaining changed files (listed above) from the folder.',
    uncommitted:
      'The author also has uncommitted changes in these files, which are NOT part of this review. Mention them in the summary if they look like they belong in the branch:',
    previous: 'Previous findings to verify (put each in `previous` with `fixed` or `open`):',
    userNotes: 'The user (the author\'s lead) said, and this overrides your own preferences:',
    checklistTitle: 'Cover, in this order of importance:',
    checklist: [
      'End-to-end flow: follow the change from its entry point to its effects; nothing left half-wired.',
      'Functional correctness against the intent and the ticket.',
      'Edge cases: empty, null, limits, ordering, time zones, retries, partial failures.',
      'Error handling: failures surfaced, not swallowed; no crash paths.',
      'Security: input validation, authorization, secrets, injection, data exposure.',
      'Data and migrations: compatibility, rollback, defaults, existing rows.',
      'Concurrency: races, idempotency, ordering, locks, shared state.',
      'Missing tests for the behavior that changed.',
      'Consistency with the conventions of this repository (look at neighboring code).',
      'Readability: names, dead code, comments that lie, needless complexity.'
    ],
    extraChecklist: 'Also check (project checklist):',
    severities:
      'Severities: `blocker` (must not merge: bug, data loss, security hole, broken flow), `major` (should be fixed before merge), `minor` (worth fixing, not blocking), `nit` (style or taste). Every finding needs the file and line, why it matters, and a concrete fix.',
    scope:
      'Scope: judge whether what you ask for is proportionate to the size and intent of this change. If you would ask for a redesign, a large refactor or work outside the ticket, or if you and the author keep disagreeing on design, set `escalate.needed` to true with the reason, so the user decides. Mark such items as `minor` unless they are real defects.',
    output:
      'Write a short human summary first, then end your reply with exactly one fenced ```json block with this shape (no comments inside):',
    language: 'Write everything in English: the summary and the text of every finding and note.'
  },
  es: {
    intro:
      'Eres el revisor de código de la rama `{branch}`, que se abrirá como pull request hacia `{base}`. Esta es la ronda de revisión {round} de un máximo de {maxRounds}. El equipo quiere UNA pasada exhaustiva: informa ahora todo lo que encuentres, para que el autor no reciba una tanda nueva de comentarios en cada ronda. Sé preciso y concreto; no rellenes la lista.',
    intro2:
      'Ronda {round}: el autor subió commits nuevos después de tu última revisión. Revisa el delta desde `{fromSha}` (abajo), vuelve a mirar la rama entera donde el delta la toca y verifica cada hallazgo anterior listado abajo: indica si está corregido o sigue abierto. Informa como hallazgos nuevos solo problemas realmente nuevos.',
    readOnly:
      'Esta carpeta es una copia de solo lectura de la rama en `{headSha}`. Lee los archivos que necesites, pero no edites archivos, no ejecutes comandos que cambien algo, no hagas commit ni push. Tu única salida es la revisión.',
    context: 'Base de fusión con `{baseRef}`: `{mergeBase}`.',
    ticket: 'Ticket: {key} "{title}". Compara el cambio con lo que pide el ticket.',
    ticketNoTitle: 'Ticket: {key}. Compara el cambio con lo que pide el ticket.',
    noTicket: 'No hay ticket vinculado: deduce la intención a partir de los commits y del código.',
    commits: 'Commits de la rama:',
    stat: 'Archivos cambiados:',
    diff: 'Los cambios a revisar están en `{diffFile}`, en esta carpeta: la salida de `git diff {mergeBase}..{headSha}`. Léelo primero y después lee aquí los archivos cambiados y el código que los rodea para tener contexto. Ese archivo no forma parte de la rama: no lo revises.',
    diffDelta: 'Los cambios desde tu última revisión están en `{diffFile}`, en esta carpeta: la salida de `git diff {fromSha}..{headSha}`. Léelo primero y después lee aquí los archivos cambiados y el código que los rodea para tener contexto. Ese archivo no forma parte de la rama: no lo revises.',
    truncated: 'Ese archivo de diff se cortó por tamaño. Lee los demás archivos cambiados (listados arriba) desde la carpeta.',
    uncommitted:
      'El autor también tiene cambios sin commit en estos archivos, que NO forman parte de esta revisión. Menciónalos en el resumen si parece que pertenecen a la rama:',
    previous: 'Hallazgos anteriores a verificar (pon cada uno en `previous` con `fixed` u `open`):',
    userNotes: 'El usuario (responsable del autor) indicó lo siguiente, y prevalece sobre tus preferencias:',
    checklistTitle: 'Cubre, en este orden de importancia:',
    checklist: [
      'Flujo de punta a punta: sigue el cambio desde su punto de entrada hasta sus efectos; nada a medio conectar.',
      'Corrección funcional respecto de la intención y del ticket.',
      'Casos límite: vacío, nulo, límites, orden, zonas horarias, reintentos, fallos parciales.',
      'Manejo de errores: los fallos se informan, no se ocultan; sin caminos que terminen en un cierre inesperado.',
      'Seguridad: validación de entradas, autorización, secretos, inyección, exposición de datos.',
      'Datos y migraciones: compatibilidad, reversión, valores por defecto, filas existentes.',
      'Concurrencia: condiciones de carrera, idempotencia, orden, bloqueos, estado compartido.',
      'Pruebas que faltan para el comportamiento que cambió.',
      'Coherencia con las convenciones de este repositorio (mira el código vecino).',
      'Legibilidad: nombres, código muerto, comentarios desactualizados, complejidad innecesaria.'
    ],
    extraChecklist: 'Revisa también (checklist del proyecto):',
    severities:
      'Severidades: `blocker` (no se puede fusionar: error, pérdida de datos, hueco de seguridad, flujo roto), `major` (debe corregirse antes de fusionar), `minor` (vale la pena corregirlo, no bloquea), `nit` (estilo o gusto). Cada hallazgo necesita archivo y línea, por qué importa y una corrección concreta.',
    scope:
      'Alcance: evalúa si lo que pides es proporcionado al tamaño y la intención de este cambio. Si pedirías un rediseño, una refactorización grande o trabajo fuera del ticket, o si tú y el autor siguen en desacuerdo sobre el diseño, pon `escalate.needed` en true con el motivo, para que decida el usuario. Marca esos puntos como `minor` salvo que sean defectos reales.',
    output:
      'Escribe primero un resumen breve para personas y termina tu respuesta con exactamente un bloque ```json con esta forma (sin comentarios dentro):',
    language: 'Responde todo en español: el resumen y los textos de cada hallazgo (`title`, `why`, `fix`) y de cada `note`. Los nombres de los campos y los valores de `severity`, `status` y `assessment` quedan en inglés.'
  }
}

/** The JSON shape the reviewer must end with. Field names stay in English in every language. */
export const REVIEW_JSON_SCHEMA = `{
  "summary": "one paragraph",
  "scope": { "assessment": "proportionate | too_demanding | scope_creep", "note": "why" },
  "findings": [
    { "severity": "blocker | major | minor | nit", "title": "short", "file": "path/from/repo/root", "line": 42, "why": "what breaks and when", "fix": "the concrete change" }
  ],
  "previous": [ { "id": "F1", "status": "fixed | open", "note": "optional" } ],
  "escalate": { "needed": false, "reason": "" }
}`

const fill = (template: string, params: Record<string, string | number>): string => template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))

const short = (sha: string | undefined) => (sha ?? '').slice(0, 12)

/** Lines of the user's own checklist: one item per non-empty line, list markers dropped. */
export function checklistItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
}

function findingLine(f: ReviewFinding): string {
  const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''
  const dispute = f.status === 'disputed' && f.disputeReason ? ` — author disputes: ${f.disputeReason}` : ''
  const fixed = f.status === 'fixed' && f.fixedBy === 'dev' ? ` — author says fixed${f.fixNote ? `: ${f.fixNote}` : ''}` : ''
  return `- ${f.id} [${f.severity}] ${f.title}${where}${dispute}${fixed}`
}

/** The reviewer prompt for one round. Pure: the caller gathers the git facts. */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const s = REVIEW_PROMPT_STRINGS[input.language] ?? REVIEW_PROMPT_STRINGS.en
  const p = {
    branch: input.branch,
    base: input.base,
    baseRef: input.baseRef,
    round: input.round,
    maxRounds: input.maxRounds,
    headSha: short(input.headSha),
    mergeBase: short(input.mergeBase),
    fromSha: short(input.fromSha),
    diffFile: input.diffFile,
    key: input.ticket?.key ?? '',
    title: input.ticket?.title ?? ''
  }
  const parts: string[] = [fill(s.intro, p)]
  // `round` counts within the cycle, so a delta can come in round 1 of a later cycle.
  const delta = Boolean(input.fromSha)
  if (delta) parts.push(fill(s.intro2, p))
  parts.push(fill(s.readOnly, p), fill(s.context, p))
  parts.push(input.ticket ? fill(input.ticket.title ? s.ticket : s.ticketNoTitle, p) : s.noTicket)
  if (input.userNotes.length) parts.push([s.userNotes, ...input.userNotes.map((n) => `> ${n.replace(/\n/g, '\n> ')}`)].join('\n'))
  if (delta && input.previous.length) parts.push([s.previous, ...input.previous.map(findingLine)].join('\n'))
  parts.push([s.checklistTitle, ...s.checklist.map((c, i) => `${i + 1}. ${c}`)].join('\n'))
  const extra = checklistItems(input.checklist)
  if (extra.length) parts.push([s.extraChecklist, ...extra.map((c) => `- ${c}`)].join('\n'))
  parts.push(s.severities, s.scope)
  if (input.commits.length) parts.push([s.commits, ...input.commits.map((c) => `- ${c}`)].join('\n'))
  if (input.diffStat.trim()) parts.push(`${s.stat}\n\`\`\`\n${input.diffStat.trim()}\n\`\`\``)
  if (input.uncommitted.length) parts.push([s.uncommitted, ...input.uncommitted.slice(0, 50).map((f) => `- ${f}`)].join('\n'))
  parts.push(fill(delta ? s.diffDelta : s.diff, p))
  if (input.diffTruncated) parts.push(s.truncated)
  parts.push(s.language)
  parts.push(`${s.output}\n\`\`\`json\n${REVIEW_JSON_SCHEMA}\n\`\`\``)
  return parts.join('\n\n')
}

interface MessageStrings {
  header: string
  headerRound: string
  reviewer: string
  blocking: string
  other: string
  where: string
  why: string
  fix: string
  instructions: string
  raw: string
  opinion: string
  severity: Record<ReviewSeverity, string>
}

/** The message sent into the dev session's chat, per language. */
export const DEV_MESSAGE_STRINGS: Record<ReviewLanguage, MessageStrings> = {
  en: {
    header: 'Code review of branch `{branch}` (round {round} of {maxRounds}), before the pull request to `{base}`. {count} to fix.',
    headerRound: 'Still open from earlier rounds: {stillOpen}.',
    reviewer: 'Reviewed by {reviewer}.',
    blocking: 'Blockers and majors (fix these first):',
    other: 'Minors and nits:',
    where: 'Where',
    why: 'Why',
    fix: 'Fix',
    instructions:
      'Fix them, run the tests, and commit (do not open the pull request yet). The reviewer checks the new commits in the next round. For each finding you fixed, end your reply with one line `FIXED F<n>: <what you changed>`. If you disagree with a finding, do not change it: reply with one line per finding, `DISPUTE F<n>: <reason>`.',
    raw: 'The reviewer\'s reply could not be read as structured findings; here it is as it came:',
    opinion: 'A note from the user about this review:',
    severity: { blocker: 'blocker', major: 'major', minor: 'minor', nit: 'nit' }
  },
  es: {
    header: 'Revisión de código de la rama `{branch}` (ronda {round} de {maxRounds}), antes del pull request hacia `{base}`. {count} por corregir.',
    headerRound: 'Siguen abiertos de rondas anteriores: {stillOpen}.',
    reviewer: 'Revisó: {reviewer}.',
    blocking: 'Bloqueantes y mayores (corrige estos primero):',
    other: 'Menores y detalles:',
    where: 'Dónde',
    why: 'Por qué',
    fix: 'Corrección',
    instructions:
      'Corrígelos, ejecuta las pruebas y haz commit (no abras el pull request todavía). El revisor verifica los commits nuevos en la próxima ronda. Por cada hallazgo que corregiste, termina tu respuesta con una línea `FIXED F<n>: <qué cambiaste>`. Si no estás de acuerdo con un hallazgo, no lo cambies: responde con una línea por hallazgo, `DISPUTE F<n>: <motivo>`.',
    raw: 'La respuesta del revisor no se pudo leer como hallazgos estructurados; esta es tal como llegó:',
    opinion: 'Una nota del usuario sobre esta revisión:',
    severity: { blocker: 'bloqueante', major: 'mayor', minor: 'menor', nit: 'detalle' }
  }
}

const SEVERITY_ORDER = (f: ReviewFinding) => REVIEW_SEVERITIES.indexOf(f.severity)

/** Findings worth sending: open ones, most severe first, then in discovery order. */
export function sortedOpenFindings(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return findings.filter((f) => f.status === 'open').sort((a, b) => SEVERITY_ORDER(a) - SEVERITY_ORDER(b) || Number(a.id.slice(1)) - Number(b.id.slice(1)))
}

export interface DevMessageInput {
  language: ReviewLanguage
  branch: string
  base: string
  round: number
  maxRounds: number
  findings: readonly ReviewFinding[]
  /** Who reviewed (agent, account, model), shown under the header. */
  reviewer?: string
}

/** One clear message with every open finding: blockers and majors first, then minors and nits. */
export function formatDevMessage(input: DevMessageInput): string {
  const s = DEV_MESSAGE_STRINGS[input.language] ?? DEV_MESSAGE_STRINGS.en
  const open = sortedOpenFindings(input.findings)
  const lines: string[] = [fill(s.header, { branch: input.branch, base: input.base, round: input.round, maxRounds: input.maxRounds, count: open.length })]
  const carried = open.filter((f) => f.round < input.round).map((f) => f.id)
  if (input.reviewer) lines.push(fill(s.reviewer, { reviewer: input.reviewer }))
  if (carried.length) lines.push(fill(s.headerRound, { stillOpen: carried.join(', ') }))
  const block = (title: string, list: ReviewFinding[]) => {
    if (!list.length) return
    lines.push('', `## ${title}`)
    for (const f of list) {
      lines.push('', `### ${f.id} [${s.severity[f.severity]}] ${f.title}`)
      if (f.file) lines.push(`- ${s.where}: \`${f.file}${f.line ? `:${f.line}` : ''}\``)
      if (f.why) lines.push(`- ${s.why}: ${f.why}`)
      if (f.fix) lines.push(`- ${s.fix}: ${f.fix}`)
    }
  }
  block(s.blocking, open.filter((f) => BLOCKING_SEVERITIES.includes(f.severity)))
  block(s.other, open.filter((f) => !BLOCKING_SEVERITIES.includes(f.severity)))
  lines.push('', s.instructions)
  return lines.join('\n')
}

/** An unparseable reviewer reply, forwarded verbatim once the user lets the loop continue. */
export function formatRawDevMessage(language: ReviewLanguage, raw: string): string {
  const s = DEV_MESSAGE_STRINGS[language] ?? DEV_MESSAGE_STRINGS.en
  return `${s.raw}\n\n${raw.trim()}\n\n${s.instructions}`
}

/** The user's opinion, as the dev session reads it. */
export function formatOpinionMessage(language: ReviewLanguage, text: string): string {
  const s = DEV_MESSAGE_STRINGS[language] ?? DEV_MESSAGE_STRINGS.en
  return `${s.opinion}\n\n${text.trim()}`
}
