import { RotateCcw, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { boardLiveness, type BoardBlock, type BoardNode, type StoredBoard } from '@workhub/core'
import { Button, IconButton } from '../../components/atoms'
import { Card } from '../../components/molecules'
import { useI18n } from '../../i18n/I18nProvider'
import type { MessageKey } from '../../i18n/translate'
import { blockIdentities, boardLayoutKey, filterBlockByAgent, layoutOf, untitledNumbers, withLayout, type AgentMatch, type PickedAgent } from '../../lib/boards'
import { BOARD_LAYOUTS_MAX, setPrefs, usePrefs } from '../../lib/prefs'
import { BoardHeading } from '../health/ServiceBoard'
import { BoardGraph } from './BoardGraph'
import { BoardLog } from './BoardLog'
import { ListBlock, StepsBlock, TableBlock, TextBlock } from './BoardBlocks'

const KIND_NAME: Record<BoardBlock['type'], MessageKey> = {
  steps: 'boards.kind.steps',
  graph: 'boards.kind.graph',
  list: 'boards.kind.list',
  table: 'boards.kind.table',
  log: 'boards.kind.log',
  text: 'boards.kind.text'
}

export interface BoardViewProps {
  profileId: string
  /** The board's key (its chat and id): moved boxes are kept under it. */
  boardKey: string
  stored: StoredBoard
  /** The screen's ticking clock. */
  now: number
}

/**
 * The blocks of a board, in the order the tool sent them, each in a card under a small heading as on
 * Health. The person may move the graph's boxes and press an agent on the graph to see only what it
 * did. None of it reaches the tool.
 */
export function BoardView({ profileId, boardKey, stored, now }: BoardViewProps) {
  const { t } = useI18n()
  const prefs = usePrefs()
  const blocks = stored.board.blocks
  const numbers = untitledNumbers(blocks)
  const ids = blockIdentities(blocks)
  const [picked, setPicked] = useState<string | null>(null)
  const nodes = blocks.flatMap((b) => (b.type === 'graph' ? b.nodes : []))
  const nodeIds = new Set(nodes.map((n) => n.id))
  // The pick goes when its agent leaves the graph; a re-send that keeps it keeps the pick, with the name it has now.
  const pickedNode = picked === null ? undefined : nodes.find((n) => n.id === picked)
  const pickedGone = picked !== null && !pickedNode
  useEffect(() => {
    if (pickedGone) setPicked(null)
  }, [pickedGone])
  const shownAgent: PickedAgent | null = pickedNode ? { id: pickedNode.id, label: pickedNode.label } : null
  // A board that is not live stops the time working of its agents at its last arrival.
  const until = boardLiveness(stored, now) === 'live' ? now : stored.receivedAt
  const pick = (node: BoardNode | null) => setPicked(node ? node.id : null)
  const nameOf = (i: number) => blocks[i]!.title || (numbers[i] ? `${t(KIND_NAME[blocks[i]!.type])} ${numbers[i]}` : t(KIND_NAME[blocks[i]!.type]))

  return (
    <div className="flex flex-col gap-4" data-testid="board-view">
      {shownAgent && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent bg-accent-soft py-0.5 pl-3 pr-1 text-sm" role="status" data-testid="board-agent-filter">
            {t('boards.agent.showing', { agent: shownAgent.label })}
            <IconButton size="sm" className="size-6" label={t('boards.agent.clear')} icon={<X className="size-3.5" aria-hidden />} onClick={() => setPicked(null)} />
          </span>
        </div>
      )}
      {blocks.map((block, i) => {
        const filtered = shownAgent ? filterBlockByAgent(block, shownAgent, nodeIds) : { block, match: 'none' as AgentMatch }
        const name = nameOf(i)
        const layoutKey = boardLayoutKey(profileId, boardKey, ids[i]!)
        const moved = block.type === 'graph' ? layoutOf(prefs.boardLayouts, layoutKey) : {}
        return (
          <Card key={ids[i]} className="flex flex-col gap-3 p-4" data-block={block.type} aria-label={name}>
            <div className="flex items-center gap-2">
              {block.title && <BoardHeading>{block.title}</BoardHeading>}
              {filtered.match === 'mention' && shownAgent && <span className="text-xs text-subtle">{t('boards.agent.byMention', { agent: shownAgent.label })}</span>}
              <span className="flex-1" />
              {block.type === 'graph' && Object.keys(moved).length > 0 && (
                <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={() => setPrefs({ boardLayouts: [...withLayout(prefs.boardLayouts, layoutKey, null, BOARD_LAYOUTS_MAX)] })}>
                  {t('boards.layout.reset')}
                </Button>
              )}
            </div>
            {emptiedBy(block, filtered.block) && shownAgent ? (
              <p className="py-2 text-sm text-muted" data-testid="board-agent-empty">{t('boards.agent.none', { agent: shownAgent.label })}</p>
            ) : renderBlock(filtered.block, now, until, numbers[i], {
              picked: shownAgent?.id ?? null,
              onPick: pick,
              overrides: moved,
              onMove: (boxes) => setPrefs({ boardLayouts: [...withLayout(prefs.boardLayouts, layoutKey, { ...boxes }, BOARD_LAYOUTS_MAX)] })
            })}
          </Card>
        )
      })}
    </div>
  )
}

/** Entries of a block, for telling "the filter emptied it" from "nothing has arrived". */
const entriesOf = (b: BoardBlock): number => (b.type === 'list' ? b.items.length : b.type === 'table' ? b.rows.length : b.type === 'log' ? b.entries.length : -1)
const emptiedBy = (before: BoardBlock, after: BoardBlock): boolean => entriesOf(before) > 0 && entriesOf(after) === 0

function renderBlock(
  block: BoardBlock,
  now: number,
  until: number,
  number: number | undefined,
  graph: { picked: string | null; onPick: (n: BoardNode | null) => void; overrides: Record<string, { x: number; y: number }>; onMove: (o: Record<string, { x: number; y: number }>) => void }
): ReactNode {
  switch (block.type) {
    case 'steps':
      return <StepsBlock block={block} now={now} />
    case 'graph':
      return <BoardGraph block={block} number={number} now={until} {...graph} />
    case 'list':
      return <ListBlock block={block} now={now} />
    case 'table':
      return <TableBlock block={block} />
    case 'log':
      return <BoardLog block={block} now={now} number={number} />
    case 'text':
      return <TextBlock block={block} />
  }
}
