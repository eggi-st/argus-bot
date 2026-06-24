'use strict'
require('dotenv').config()
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
