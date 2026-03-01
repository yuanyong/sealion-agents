/**
 * electron-log/renderer shim for web
 *
 * Replaces electron-log/renderer with browser console logging.
 */

const log = {
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
  verbose: console.log.bind(console),
  silly: console.log.bind(console),
  log: console.log.bind(console),
  transports: {},
  scope: (name: string) => ({
    info: (...args: unknown[]) => console.info(`[${name}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${name}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${name}]`, ...args),
    debug: (...args: unknown[]) => console.debug(`[${name}]`, ...args),
    verbose: (...args: unknown[]) => console.log(`[${name}]`, ...args),
    silly: (...args: unknown[]) => console.log(`[${name}]`, ...args),
    log: (...args: unknown[]) => console.log(`[${name}]`, ...args),
  }),
}

export default log
