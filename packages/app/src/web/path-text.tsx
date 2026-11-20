import { cn } from '../renderer/lib/cn'
import { splitPath } from './changes-pages'

/**
 * A path on one line that never loses its end. When it does not fit, the middle is cut: the start
 * gives way first (an ellipsis after it), then, if the last `keep` segments alone are still too
 * wide, their own start (an ellipsis before them), so the final characters, which tell two paths
 * apart, are always on screen. The full path is its tooltip.
 */
export function PathText({ path, keep = 1, className }: { path: string; keep?: number; className?: string }) {
  const { head, tail } = splitPath(path, keep)
  return (
    <span dir="ltr" title={path} className={cn('flex min-w-0 font-mono', className)}>
      {head && <span className="min-w-0 truncate">{head}</span>}
      {/* `rtl` puts the tail's ellipsis at its start; `bdi` keeps its slashes and dots in reading order. */}
      <span className={cn('overflow-hidden text-left text-ellipsis whitespace-nowrap [direction:rtl]', head ? 'max-w-[75%] shrink-0' : 'min-w-0')}>
        <bdi dir="ltr">{tail}</bdi>
      </span>
    </span>
  )
}
