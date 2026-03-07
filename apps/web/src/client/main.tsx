/**
 * Web Entry Point
 *
 * Replaces the Electron renderer's main.tsx.
 * Instead of Sentry Electron integration, uses standard Sentry browser SDK.
 * Installs the WebAPI adapter before rendering so that all shared renderer
 * code that references window.electronAPI works identically.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider, useAtomValue } from 'jotai'
import { installWebAPI } from './web-api'
import { ThemeProvider } from '@/context/ThemeContext'
import { windowWorkspaceIdAtom } from '@/atoms/sessions'
import { Toaster } from '@/components/ui/sonner'
import App from '@/App'
import './index.css'

// Install WebAPI adapter BEFORE any React code runs
// This makes window.electronAPI available globally
installWebAPI()

/**
 * Minimal fallback UI shown when the entire React tree crashes.
 */
function CrashFallback({ error }: { error?: Error }) {
  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3">
      <p className="text-base font-medium">Something went wrong</p>
      <p className="text-[13px]">{error?.message || 'Please refresh the page.'}</p>
      <button
        onClick={() => window.location.reload()}
        className="mt-2 px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer"
      >
        Reload
      </button>
    </div>
  )
}

/**
 * Root component with ThemeProvider and App
 */
function Root() {
  const workspaceId = useAtomValue(windowWorkspaceIdAtom)

  return (
    <ThemeProvider activeWorkspaceId={workspaceId}>
      <App />
      <Toaster />
    </ThemeProvider>
  )
}

/**
 * Error boundary for the web version
 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Application crash:', error, info)
  }
  render() {
    if (this.state.error) {
      return <CrashFallback error={this.state.error} />
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <JotaiProvider>
        <Root />
      </JotaiProvider>
    </ErrorBoundary>
  </React.StrictMode>
)
