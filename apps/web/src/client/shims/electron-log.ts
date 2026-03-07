/**
 * electron-log shim for web
 *
 * Replaces electron-log with browser console logging.
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
  scope: () => log,
}

export default log
