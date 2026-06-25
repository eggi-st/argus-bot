'use strict'
const bus      = require('../core/event-bus')
const telegram = require('./telegram')

function init() {
  // Circuit breaker opened → P1 alert
  bus.onFast('risk_gate_blocked', payload => {
    const reason = payload?.reason || ''
    if (reason.toLowerCase().includes('circuit breaker') || reason.toLowerCase().includes('breaker')) {
      telegram.circuitBreaker(reason)
    }
  })

  // Dry run position closed → P3 info
  bus.onSlow('outcome_recorded', payload => {
    if (payload?.net_pnl_pct == null) return
    telegram.dryRunResult({
      token:       payload.token_symbol || '?',
      strategy:    payload.strategy     || '?',
      netPnlPct:   payload.net_pnl_pct,
      holdMinutes: payload.hold_minutes ?? 0,
    })
  })

  console.log('[Alerts] Telegram wiring ready')
}

module.exports = { init }
