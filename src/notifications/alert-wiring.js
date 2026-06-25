'use strict'
const bus      = require('../core/event-bus')
const telegram = require('./telegram')

function init() {
  // Circuit breaker opened → P1 alert (any risk gate block triggers alert)
  bus.onFast('risk_gate_blocked', payload => {
    const reason = payload?.reason || 'unknown'
    telegram.circuitBreaker(reason)
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

  // Smart money wallet aligned with Argus recommendation → P3 signal
  bus.onSlow('wallet_action_detected', payload => {
    if (payload?.wallet_type !== 'smart_money') return
    if (payload?.match_category !== 'followed') return
    const label  = payload.wallet_label || 'Smart Money'
    const token  = payload.token_symbol || '?'
    const action = (payload.action_type || '').replace(/_/g, ' ')
    telegram.send(
      `🐋 <b>${label}</b>: ${action} ${token} — konfirmasi dengan rekomendasi Argus`,
      'P3'
    )
  })

  console.log('[Alerts] Telegram wiring ready')
}

module.exports = { init }
