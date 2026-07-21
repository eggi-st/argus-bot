'use strict'
// override:true — the .env file always wins over a stale/inherited process.env
// (e.g. a PM2-cached or shell-exported TELEGRAM_BOT_TOKEN). Without this, a bot
// token leaked into the environment from another app silently routes Argus's
// messages to the wrong bot.
require('dotenv').config({ override: true })
const { init } = require('./src/core/init')

process.on('uncaughtException', (err) => {
  // After an uncaught exception the process is in an undefined state — logging and continuing
  // risks acting on corrupted state (SQLite writes, Meridian signals). Exit and let PM2 restart
  // clean. (unhandledRejection stays log-only: transient fire-and-forget rejections shouldn't
  // trigger a full restart, and there are many such paths.)
  console.error('[Argus] Uncaught exception — exiting for clean PM2 restart:', err.message)
  console.error(err.stack)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('[Argus] Unhandled rejection:', reason)
})

process.on('SIGINT', async () => {
  console.log('\n[Argus] Shutting down…')
  try {
    const scheduler = require('./src/core/scheduler')
    const server = require('./src/server')
    scheduler.stop()
    await server.stop()
  } catch {}
  process.exit(0)
})

init().catch((err) => {
  console.error('[Argus] Fatal startup error:', err.message)
  process.exit(1)
})
