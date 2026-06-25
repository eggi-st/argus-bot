'use strict'

// Layered startup — each layer waits for the previous before proceeding.
// Layer 0: Event Bus (all others subscribe to it — must be first)
// Layer 1: Persistence (Memory System, RiskState)
// Layer 2: Intelligence Core (placeholder — Phase 1)
// Layer 3: Scheduler + Wallet Observer (placeholder — Phase 3)
// Layer 4: UI + Notifications (Express server, Telegram)

async function init() {
  console.log('\n' + '─'.repeat(50))
  console.log('  🦅  ARGUS  v0.4.0')
  console.log('─'.repeat(50) + '\n')

  // ── Layer 0: Event Bus ───────────────────────────────────────────────────
  process.stdout.write('[Init] Layer 0 · Event Bus... ')
  const bus = require('./event-bus')
  console.log('✓')

  // ── Layer 1: Persistence ─────────────────────────────────────────────────
  process.stdout.write('[Init] Layer 1 · Persistence... ')
  const { initSchema } = require('../db/schema')
  initSchema()

  const riskState = require('./risk-state')
  const rs = riskState.state
  const riskStatus = rs.circuit_breaker_open
    ? `⚠️  CIRCUIT BREAKER OPEN — ${rs.circuit_breaker_reason}`
    : `✓  clear (${rs.current_open_count}/${rs.limits.max_open_positions} positions, $${rs.daily_realized_loss_usd.toFixed(2)} loss today)`
  console.log(riskStatus)

  // ── Layer 2: Intelligence Core ───────────────────────────────────────────
  process.stdout.write('[Init] Layer 2 · Intelligence Core... ')
  const ic = require('../intelligence/index')
  ic.init()
  const dryRun = require('../dry-run/engine')
  dryRun.init()
  console.log('✓')

  // ── Layer 3: Scheduler + Wallet Observer ─────────────────────────────────
  process.stdout.write('[Init] Layer 3 · Scheduler... ')
  const scheduler = require('./scheduler')
  scheduler.start()
  console.log('✓')

  process.stdout.write('[Init] Layer 3 · Wallet Observer... ')
  const wallet = require('../wallet/index')
  wallet.init()
  console.log('✓')

  // ── Layer 4: Learning + AI + Hivemind ───────────────────────────────────
  process.stdout.write('[Init] Layer 4 · Pattern Library... ')
  const learning = require('../learning/index')
  learning.init()
  console.log('✓')

  process.stdout.write('[Init] Layer 4 · Hivemind Discovery... ')
  const hivemind = require('../wallet/hivemind-discovery')
  hivemind.init()
  console.log('✓')

  // ── Layer 5: Notifications + Web Server ──────────────────────────────────
  process.stdout.write('[Init] Layer 5 · Telegram... ')
  const telegram = require('../notifications/telegram')
  await telegram.init()

  const alertWiring = require('../notifications/alert-wiring')
  alertWiring.init()

  process.stdout.write('[Init] Layer 5 · Web server... ')
  const server = require('../server')
  await server.start()
  console.log('✓')

  // ── Ready ─────────────────────────────────────────────────────────────────
  const port = process.env.PORT || 4000
  console.log('\n' + '─'.repeat(50))
  console.log(`  Argus online → http://127.0.0.1:${port}`)
  console.log('─'.repeat(50) + '\n')

  await telegram.send(
    `🦅 <b>Argus online</b>\nRisk: ${rs.circuit_breaker_open ? '🔴 CB OPEN' : '🟢 clear'} | <a href="http://127.0.0.1:${port}">Dashboard</a>`,
    'P3'
  )

  return { bus, riskState, scheduler, telegram, server }
}

module.exports = { init }
