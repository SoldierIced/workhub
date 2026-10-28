import { CircleAlert, CircleCheck } from 'lucide-react'
import { Toast as RToast } from 'radix-ui'
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

interface ToastMessage {
  id: number
  text: string
  tone: 'success' | 'danger'
}

type Notify = (text: string, tone?: ToastMessage['tone']) => void
const ToastContext = createContext<Notify>(() => undefined)

/** Short confirmations ("Saved"); errors that need reading stay inline next to what failed. */
export function ToastProvider({ children, label }: { children: ReactNode; label: string }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const notify = useCallback<Notify>((text, tone = 'success') => {
    setToasts((list) => [...list, { id: Date.now() + Math.random(), text, tone }])
  }, [])
  return (
    <ToastContext.Provider value={notify}>
      <RToast.Provider duration={2500} label={label}>
        {children}
        {toasts.map((m) => (
          <RToast.Root
            key={m.id}
            onOpenChange={(open) => !open && setToasts((list) => list.filter((x) => x.id !== m.id))}
            className="flex animate-slide-in items-center gap-2 rounded-lg border border-border bg-surface-raised px-3.5 py-2.5 shadow-lg"
          >
            {m.tone === 'success' ? <CircleCheck className="size-4 text-success" aria-hidden /> : <CircleAlert className="size-4 text-danger" aria-hidden />}
            <RToast.Title className={cn('text-base')}>{m.text}</RToast.Title>
          </RToast.Root>
        ))}
        <RToast.Viewport className="fixed right-5 bottom-5 z-[60] flex w-80 flex-col gap-2 outline-none" />
      </RToast.Provider>
    </ToastContext.Provider>
  )
}

export function useToast(): Notify {
  return useContext(ToastContext)
}
