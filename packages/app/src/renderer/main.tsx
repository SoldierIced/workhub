import { createRoot } from 'react-dom/client'
import { App } from './App'
import { parseTicketHash, TicketWindowRoot } from './screens/TicketWindow'
import { readPrefs, resolveTheme } from './lib/prefs'
import './styles.css'

// Set the theme before the first paint so a light OS never flashes the dark palette.
document.documentElement.dataset['theme'] = resolveTheme(readPrefs().theme, matchMedia('(prefers-color-scheme: dark)').matches)

// A ticket opens in its own window: same renderer, routed by the URL hash.
const ticketWindow = parseTicketHash(location.hash)
createRoot(document.getElementById('root')!).render(
  ticketWindow ? <TicketWindowRoot profileId={ticketWindow.profileId} ticketKey={ticketWindow.key} /> : <App />
)
