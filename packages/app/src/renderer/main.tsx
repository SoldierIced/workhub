import { createRoot } from 'react-dom/client'
import { App } from './App'
import { parsePrWindowHash } from './lib/pullRequests'
import { readPrefs, resolveTheme } from './lib/prefs'
import { PullRequestWindow } from './screens/PullRequestWindow'
import './styles.css'

// Set the theme before the first paint so a light OS never flashes the dark palette.
document.documentElement.dataset['theme'] = resolveTheme(readPrefs().theme, matchMedia('(prefers-color-scheme: dark)').matches)

// A pull request window is the same bundle opened with `#pr?profile=…&url=…`.
const prWindow = parsePrWindowHash(location.hash)

createRoot(document.getElementById('root')!).render(prWindow ? <PullRequestWindow profileId={prWindow.profileId} url={prWindow.url} /> : <App />)
