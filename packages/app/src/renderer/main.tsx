import { createRoot } from 'react-dom/client'
import { App } from './App'
import { readPrefs, resolveTheme } from './lib/prefs'
import './styles.css'

// Set the theme before the first paint so a light OS never flashes the dark palette.
document.documentElement.dataset['theme'] = resolveTheme(readPrefs().theme, matchMedia('(prefers-color-scheme: dark)').matches)

createRoot(document.getElementById('root')!).render(<App />)
