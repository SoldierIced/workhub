import { ChevronRight, Folder, FolderTree, Search, Star, X } from 'lucide-react'
import { ContextMenu } from 'radix-ui'
import { useMemo, useState, type KeyboardEvent } from 'react'
import type { WorkspaceFolder } from '@shared/api'
import { useI18n } from '../../i18n/I18nProvider'
import { cn } from '../../lib/cn'
import { folderSections, toggleFavorite, type FolderItem, type FolderSessionInfo } from '../../lib/folders'
import { setPrefs, usePrefs } from '../../lib/prefs'

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
 * Workhub 1's folder browser: a filter field, then Favorites, Recent and All folders (folded);
 * typing replaces them with the matching folders. A click starts a session there.
 */
export function FolderBrowser({ workspaces, sessions, profileId, accent, onOpen, onResume }: FolderBrowserProps) {
  const { t } = useI18n()
  const prefs = usePrefs()
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const sections = useMemo(
    () => folderSections({ workspaces, favorites: prefs.favoriteFolders, sessions, profileId, query }),
    [workspaces, prefs.favoriteFolders, sessions, profileId, query]
  )
  const star = (path: string) => setPrefs({ favoriteFolders: toggleFavorite(prefs.favoriteFolders, path) })
  const list = (items: FolderItem[], label: string) => (
    <ul className="flex flex-col gap-0.5" aria-label={label}>
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
      {sections.results ? (
        <>
          <SubTitle>{t('sidebar.results')}</SubTitle>
          {sections.results.length ? list(sections.results, t('sidebar.results')) : <p className="px-2.5 py-1 text-xs text-subtle">{t('sidebar.noFolderMatch')}</p>}
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
          {sections.all.length > 0 && (
            <>
              <button
                type="button"
                aria-expanded={showAll}
                onClick={() => setShowAll((v) => !v)}
                data-testid="all-folders"
                className="mt-1 flex h-7 w-full items-center gap-2 rounded-md px-2.5 text-left text-base text-muted hover:bg-surface-hover hover:text-text"
              >
                <ChevronRight className={cn('size-3.5 shrink-0 text-subtle transition-transform duration-150', showAll && 'rotate-90')} aria-hidden />
                <span className="flex-1 truncate">{t('sidebar.allFolders')}</span>
                <span className="text-xs tabular-nums text-subtle">{sections.all.length}</span>
              </button>
              {showAll && list(sections.all, t('sidebar.allFolders'))}
            </>
          )}
        </>
      )}
    </div>
  )
}

function SubTitle({ children }: { children: string }) {
  return <h3 className="px-2.5 pt-1.5 pb-0.5 text-xs font-medium text-subtle">{children}</h3>
}

function FolderRow({ folder, accent, onOpen, onStar, onResume }: { folder: FolderItem; accent?: string; onOpen: () => void; onStar: () => void; onResume?: () => void }) {
  const { t, tn } = useI18n()
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
            {folder.open > 0 && (
              <span className="rounded-full bg-accent-soft px-1.5 text-xs font-medium tabular-nums text-accent" title={tn('sidebar.openInFolder', folder.open)}>
                {folder.open}
                <span className="sr-only"> {tn('sidebar.openInFolder', folder.open)}</span>
              </span>
            )}
          </button>
        </ContextMenu.Trigger>
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
            <ContextMenu.Item className={FOLDER_MENU_ITEM} onSelect={() => void window.hub.history.revealFolder(folder.path)}>
              {t('folder.reveal')}
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <button
        type="button"
        aria-pressed={folder.favorite}
        aria-label={t(folder.favorite ? 'sidebar.removeFavorite' : 'sidebar.addFavorite', { folder: folder.name })}
        title={t(folder.favorite ? 'sidebar.removeFavorite' : 'sidebar.addFavorite', { folder: folder.name })}
        onClick={onStar}
        className={cn(
          'mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-surface-hover',
          folder.favorite ? 'text-warning' : 'text-subtle opacity-0 group-hover/folder:opacity-100 focus-visible:opacity-100'
        )}
      >
        <Star className={cn('size-3.5', folder.favorite && 'fill-current')} aria-hidden />
      </button>
    </li>
  )
}
