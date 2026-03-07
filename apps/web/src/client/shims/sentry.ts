/**
 * Sentry shim for web
 *
 * Replaces @sentry/electron/renderer and @sentry/electron with no-op stubs.
 * In production, you'd replace this with @sentry/browser integration.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const noop = (..._args: any[]): any => {}

// @sentry/electron/renderer init
export const init = (options: any, reactInit?: (opts: any) => void) => {
  if (reactInit) {
    reactInit({
      ...options,
      dsn: undefined, // Don't actually initialize Sentry in dev
    })
  }
}

// @sentry/react re-exports
export const ErrorBoundary = ({ children, fallback }: { children: any; fallback: any }) => {
  // Simple passthrough - no error capture
  return children
}

export const captureConsoleIntegration = noop
export const captureException = noop
export const captureMessage = noop
export const setUser = noop
export const setTag = noop
export const setExtra = noop
export const withScope = noop
export const addBreadcrumb = noop
export const configureScope = noop
export const startSpan = noop

// Default export for `import * as Sentry`
export default {
  init: noop,
  ErrorBoundary,
  captureConsoleIntegration,
  captureException,
  captureMessage,
  setUser,
  setTag,
  setExtra,
  withScope,
  addBreadcrumb,
  configureScope,
  startSpan,
}
