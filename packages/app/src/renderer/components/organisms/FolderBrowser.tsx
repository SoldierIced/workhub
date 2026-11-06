import { ChevronRight, Folder, FolderTree, Plus, Search, Star, X } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { WorkspaceFolder } from '@shared/api'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { folderGroups, folderSections, groupMatches, isFolderOpen, toggleExpanded, toggleFavorite, type FolderGroup, type FolderItem, type FolderSessionInfo } from '../../lib/folders'
import { readPrefs, setPrefs, usePrefs } from '../../lib/prefs'

export interface FolderBrowserProps {
  workspaces: readonly WorkspaceFolder[]
  sessions: readonly FolderSessionInfo[]
  profileId: string | null
  /** The active profile's colour, on the folder icons (Workhub 1's accent). */
  accent?: string
  /** Starts a session in the folder (the new session dialog, set to it). */
  onOpen: (folder: string) => void
  /** A folder's "Resume session…" (its earlier sessions), from the row's context menu. */
  onResume?: (folder: string) => void
}

const FOLDER_MENU = 'z-50 min-w-48 animate-fade-in rounded-md border border-border bg-surface-raised p-1 shadow-lg'
const FOLDER_MENU_ITEM = 'flex h-8 cursor-default select-none items-center rounded-sm px-2 text-base outline-none data-[highlighted]:bg-accent-soft'

/**
 * Workhub 1's folder browser: a filter field, then Favorites, Recent and one foldable section per
 * profile folder with the folders (repositories) inside it, folded until the user unfolds it (kept
 * in the preferences). Typing replaces them with the matches, by profile folder, every section
 * that has one unfolded. A click on a folder starts a session there.
 */
export function FolderBrowser({ workspaces, sessions, profileId, accent, onOpen, onResume }: FolderBrowserProps) {
  const { t } = useI18n()
  const prefs = usePrefs()
  const [query, setQuery] = useState('')
  const sections = useMemo(
    () => folderSections({ workspaces, favorites: prefs.favoriteFolders, sessions, profileId, query }),
    [workspaces, prefs.favoriteFolders, sessions, profileId, query]
  )
  const groups = useMemo(() => folderGroups(sections.all), [sections.all])
  const matches = useMemo(() => (sections.results ? groupMatches(sections.all, sections.results) : null), [sections.all, sections.results])
  const star = (path: string) => setPrefs({ favoriteFolders: toggleFavorite(prefs.favoriteFolders, path) })
  const toggle = (path: string) => setPrefs({ expandedFolders: toggleExpanded(readPrefs().expandedFolders, path) })
  const list = (items: FolderItem[], label: string, className?: string) => (
    <ul className={cn('flex flex-col gap-0.5', className)} aria-label={label}>
      {items.map((f) => (
        <FolderRow key={f.path} folder={f} accent={accent} onOpen={() => onOpen(f.path)} onStar={() => star(f.path)} onResume={onResume && (() => onResume(f.path))} />
      ))}
    </ul>
  )
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && query) {
      e.stopPropagation()
      setQuery('')
    }
  }
  const nothing = !sections.favorites.length && !sections.recent.length && !sections.all.length
  const section = (g: FolderGroup, filtering: boolean) =>
    // A profile folder that is one project (nothing listed inside it), or a match with no folders
    // matching inside it, stays a plain row.
    g.children.length === 0 ? (
      <ul key={g.root.path} className="flex flex-col gap-0.5" aria-label={g.root.name}>
        <FolderRow folder={g.root} accent={accent} onOpen={() => onOpen(g.root.path)} onStar={() => star(g.root.path)} onResume={onResume && (() => onResume(g.root.path))} />
      </ul>
    ) : (
      <FolderSection
        key={g.root.path}
        group={g}
        open={isFolderOpen(g.root.path, prefs.expandedFolders, filtering)}
        filtering={filtering}
        accent={accent}
        onToggle={() => toggle(g.root.path)}
        onOpen={() => onOpen(g.root.path)}
        onStar={() => star(g.root.path)}
        onResume={onResume && (() => onResume(g.root.path))}
      >
        {list(g.children, g.root.name, 'mt-0.5 ml-3 border-l border-border pl-1')}
      </FolderSection>
    )

  return (
    <div data-testid="folder-browser" className="flex flex-col gap-0.5">
      {/* Flush with the rows: its icon over their icons, its clear button over their star. */}
      <div className="relative mb-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={t('sidebar.filterFolders')}
          aria-label={t('sidebar.filterFolders')}
          data-testid="folder-filter"
          className="h-7 w-full rounded-md border border-border bg-surface pr-8 pl-8.5 text-sm text-text placeholder:text-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            aria-label={t('sidebar.clearFilter')}
            onClick={() => setQuery('')}
            className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-subtle hover:bg-surface-hover hover:text-text"
          >
            <X className="size-3" aria-hidden />
          </button>
        )}
      </div>
      {matches ? (
        <>
          <SubTitle>{t('sidebar.results')}</SubTitle>
          {matches.groups.length || matches.other.length ? (
            <div className="flex flex-col gap-0.5" data-testid="folder-results">
              {matches.groups.map((g) => section(g, true))}
              {matches.other.length > 0 && list(matches.other, t('sidebar.results'))}
            </div>
          ) : (
            <p className="px-2.5 py-1 text-xs text-subtle">{t('sidebar.noFolderMatch')}</p>
          )}
        </>
      ) : nothing ? (
        <p className="px-2.5 py-1 text-xs text-subtle">{t('sidebar.foldersEmpty')}</p>
      ) : (
        <>
          {sections.favorites.length > 0 && (
            <>
              <SubTitle>{t('sidebar.favorites')}</SubTitle>
              {list(sections.favorites, t('sidebar.favorites'))}
            </>
          )}
          {sections.recent.length > 0 && (
            <>
              <SubTitle>{t('sidebar.recent')}</SubTitle>
              {list(sections.recent, t('sidebar.recent'))}
            </>
          )}
          {groups.length > 0 && (
            <div className="mt-1 flex flex-col gap-0.5" role="group" aria-label={t('sidebar.allFolders')} data-testid="all-folders">
              {groups.map((g) => section(g, false))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function FolderMenu({ path, onOpen, onResume }: { path: string; onOpen: () => void; onResume?: () => void }) {
  const { t } = useI18n()
  return (
    <ContextMenu.Portal>
      <ContextMenu.Content className={FOLDER_MENU}>
        <ContextMenu.Item className={FOLDER_MENU_ITEM} onSelect={onOpen}>
          {t('folder.newSession')}
        </ContextMenu.Item>
        {onResume && (
          <ContextMenu.Item className={FOLDER_MENU_ITEM} data-testid="folder-resume" onSelect={onResume}>
            {t('folder.resume')}
          </ContextMenu.Item>
        )}
        <ContextMenu.Separator className="my-1 h-px bg-border" />
        <ContextMenu.Item className={FOLDER_MENU_ITEM} onSelect={() => void window.hub.history.revealFolder(path)}>
          {t('folder.reveal')}
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  )
}

function StarButton({ folder, onStar }: { folder: FolderItem; onStar: () => void }) {
  const { t } = useI18n()
  const label = t(folder.favorite ? 'sidebar.removeFavorite' : 'sidebar.addFavorite', { folder: folder.name })
  return (
    <button
      type="button"
      aria-pressed={folder.favorite}
      aria-label={label}
      title={label}
      onClick={onStar}
      className={cn(
        'mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-surface-hover',
        folder.favorite ? 'text-warning' : 'text-subtle opacity-0 group-hover/folder:opacity-100 focus-visible:opacity-100'
      )}
    >
      <Star className={cn('size-3.5', folder.favorite && 'fill-current')} aria-hidden />
    </button>
  )
}

function OpenBadge({ open }: { open: number }) {
  const { tn } = useI18n()
  if (open <= 0) return null
  return (
    <span className="rounded-full bg-accent-soft px-1.5 text-xs font-medium tabular-nums text-accent" title={tn('sidebar.openInFolder', open)}>
      {open}
      <span className="sr-only"> {tn('sidebar.openInFolder', open)}</span>
    </span>
  )
}

interface FolderSectionProps {
  group: FolderGroup
  open: boolean
  filtering: boolean
  accent?: string
  onToggle: () => void
  onOpen: () => void
  onStar: () => void
  onResume?: () => void
  children: ReactNode
}

/**
 * A profile folder's section, like a session group: its header (the chevron, the folder's name
 * and how many folders it holds) folds the folders inside it; the + starts a session in the folder
 * itself, and its context menu has the folder's actions.
 */
function FolderSection({ group, open, filtering, accent, onToggle, onOpen, onStar, onResume, children }: FolderSectionProps) {
  const { t, tn } = useI18n()
  const { root } = group
  const count = group.children.length
  return (
    <div data-testid="folder-section" data-folder={root.path} data-open={open || undefined}>
      <div className="group/folder flex items-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text">
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <button
              type="button"
              title={root.path}
              aria-expanded={open}
              // While filtering, every section with a match is unfolded; the header folds outside it.
              disabled={filtering}
              onClick={onToggle}
              data-testid="folder-section-toggle"
              className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md pr-1 pl-2.5 text-left text-base disabled:cursor-default"
            >
              <ChevronRight className={cn('size-3.5 shrink-0 text-subtle transition-transform duration-150', open && 'rotate-90')} aria-hidden />
              <FolderTree className="size-3.5 shrink-0" style={accent ? { color: accent } : undefined} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{root.name}</span>
              <OpenBadge open={root.open} />
              <span className="text-xs tabular-nums text-subtle" title={tn('sidebar.foldersInside', count)}>
                {count}
                <span className="sr-only"> {tn('sidebar.foldersInside', count)}</span>
              </span>
            </button>
          </ContextMenu.Trigger>
          <FolderMenu path={root.path} onOpen={onOpen} onResume={onResume} />
        </ContextMenu.Root>
        <button
          type="button"
          aria-label={t('sidebar.newSessionIn', { folder: root.name })}
          title={t('sidebar.newSessionIn', { folder: root.name })}
          onClick={onOpen}
          data-testid="folder-section-new"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-subtle opacity-0 hover:bg-surface-hover hover:text-text group-hover/folder:opacity-100 focus-visible:opacity-100"
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
        <StarButton folder={root} onStar={onStar} />
      </div>
      {open && count > 0 && children}
    </div>
  )
}

function SubTitle({ children }: { children: string }) {
  return <h3 className="px-2.5 pt-1.5 pb-0.5 text-xs font-medium text-subtle">{children}</h3>
}

function FolderRow({ folder, accent, onOpen, onStar, onResume }: { folder: FolderItem; accent?: string; onOpen: () => void; onStar: () => void; onResume?: () => void }) {
  const { t } = useI18n()
  const Icon = folder.root ? FolderTree : Folder
  return (
    <li className="group/folder flex items-center rounded-md text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <button
            type="button"
            title={folder.path}
            onClick={onOpen}
            aria-label={t('sidebar.newSessionIn', { folder: folder.name })}
            data-testid="folder-row"
            className="flex h-7 min-w-0 flex-1 items-center gap-2.5 rounded-md pr-1 pl-2.5 text-left text-base"
          >
            <Icon className="size-3.5 shrink-0" style={accent ? { color: accent } : undefined} aria-hidden />
            <span className={cn('min-w-0 flex-1 truncate', folder.root && 'font-medium')}>{folder.name}</span>
            <OpenBadge open={folder.open} />
          </button>
        </ContextMenu.Trigger>
        <FolderMenu path={folder.path} onOpen={onOpen} onResume={onResume} />
      </ContextMenu.Root>
      <StarButton folder={folder} onStar={onStar} />
    </li>
  )
}
