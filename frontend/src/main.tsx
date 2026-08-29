import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { installGlobalHandlers } from './services/globalHandlers'
import { startLogger } from './services/logger'

// Observability bootstrap — before the first component renders, so even
// a crash inside App.tsx is captured and reported.
installGlobalHandlers()
startLogger()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary region="App">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
