import type { ReleaseNoteItem, ReleaseNotesEntry } from '../shared/release-notes'

/**
 * The sample update of a development run started with WORKHUB_DEMO_UPDATE=1: three versions after
 * the running one, with notes, so the update prompt can be seen without a release. Nothing is
 * contacted and nothing can be installed.
 */
export interface DemoUpdate {
  version: string
  notes: ReleaseNotesEntry[]
}

const SAMPLE: ReleaseNoteItem[][] = [
  [
    {
      kind: 'new',
      title: { en: 'See what changed before you update', es: 'Mira qué cambió antes de actualizar' },
      body: {
        en: 'The update prompt lists what is new, improved and fixed in every version you have not installed yet.',
        es: 'El aviso de actualización muestra lo nuevo, lo mejorado y lo corregido de cada versión que todavía no instalaste.'
      }
    },
    {
      kind: 'new',
      title: { en: 'Live boards beside the chat', es: 'Tableros en vivo junto al chat' },
      body: {
        en: 'Follow a job split among several agents while it happens: its stages, who does what and what was decided.',
        es: 'Sigue un trabajo repartido entre varios agentes mientras ocurre: sus etapas, quién hace qué y qué se decidió.'
      }
    },
    {
      kind: 'improved',
      title: { en: 'Milestones say why they are behind', es: 'Los hitos dicen por qué están atrasados' },
      body: { en: 'A milestone that is behind lists the open tickets holding it back.', es: 'Un hito atrasado muestra los tickets abiertos que lo frenan.' }
    },
    { kind: 'fixed', title: { en: 'The usage report clears a custom period with its filters', es: 'El reporte de uso borra el período personalizado junto con los filtros' } }
  ],
  [
    {
      kind: 'improved',
      title: { en: 'The phone app reads better on small screens', es: 'La app del teléfono se lee mejor en pantallas chicas' },
      body: { en: 'Spacing, buttons and long titles were reworked for narrow phones.', es: 'Se ajustaron los espacios, los botones y los títulos largos para teléfonos angostos.' }
    },
    { kind: 'fixed', title: { en: 'Listen summarizes with the default Claude account', es: 'Escuchar resume con la cuenta de Claude por defecto' } }
  ],
  [
    {
      kind: 'new',
      title: { en: 'Workhub skills for every agent', es: 'Skills de Workhub para todos los agentes' },
      body: {
        en: 'Settings > Agents installs them for Codex, OpenCode, Gemini CLI and Kiro, not only Claude Code.',
        es: 'Ajustes > Agentes los instala para Codex, OpenCode, Gemini CLI y Kiro, no solo Claude Code.'
      }
    },
    { kind: 'improved', title: { en: 'Boxes on a board move with the keyboard', es: 'Las cajas de un tablero se mueven con el teclado' } }
  ]
]

/** `steps` versions after `current`, in its own style: `2.0.0-alpha.44` → `2.0.0-alpha.45`, `2.1.0` → `2.1.1`. */
function later(current: string, steps: number): string {
  const numbered = /^(.*\.)(\d+)$/.exec(current)
  return numbered ? `${numbered[1]}${Number(numbered[2]) + steps}` : `${current}.${steps}`
}

const DAY_MS = 24 * 60 * 60 * 1000

/** `YYYY-MM-DD` of the local calendar (the UTC day is tomorrow's in the evening, west of Greenwich). */
function localDay(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export function demoUpdate(current: string, now: number = Date.now()): DemoUpdate {
  const notes = SAMPLE.map((items, i) => ({
    version: later(current, SAMPLE.length - i),
    date: localDay(new Date(now - i * 4 * DAY_MS)),
    items
  }))
  return { version: notes[0]!.version, notes }
}
