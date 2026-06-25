'use strict'
// override:true — the .env file always wins over a stale/inherited process.env
// (e.g. a PM2-cached or shell-exported TELEGRAM_BOT_TOKEN). Without this, a bot
// token leaked into the environment from another app silently routes Argus's
// messages to the wrong bot.
require('dotenv').config({ override: true })
const { init } = require('./src/core/init')

process.on('uncaughtException', (err) => {
  console.error('[Argus] Uncaught exception:', err.message)
  console.error(err.stack)
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
