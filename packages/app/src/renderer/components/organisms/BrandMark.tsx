import { cn } from '../../lib/cn'

/** The logo mark (hub, three agents, prompt) drawn small; decorative. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="100 100 824 824" aria-hidden className={cn('size-6 shrink-0', className)}>
      <defs>
        <linearGradient id="wh-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14B8A6" />
          <stop offset="1" stopColor="#4338CA" />
        </linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#wh-bg)" />
      <g stroke="#fff" strokeOpacity="0.55" strokeWidth="22" strokeLinecap="round">
        <line x1="512" y1="512" x2="512" y2="250" />
        <line x1="512" y1="512" x2="739" y2="643" />
        <line x1="512" y1="512" x2="285" y2="643" />
      </g>
      <g fill="#fff">
        <circle cx="512" cy="250" r="58" />
        <circle cx="739" cy="643" r="58" />
        <circle cx="285" cy="643" r="58" />
      </g>
      <circle cx="512" cy="512" r="150" fill="#fff" />
      <path d="M452 452 L520 512 L452 572" fill="none" stroke="#4338CA" strokeWidth="34" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="538" y1="572" x2="590" y2="572" stroke="#14B8A6" strokeWidth="34" strokeLinecap="round" />
    </svg>
  )
}
