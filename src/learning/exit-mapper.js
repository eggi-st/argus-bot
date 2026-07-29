'use strict'
// Maps Meridian's free-text close_reason strings onto Argus's exit-technique vocabulary.
//
// Lives here (not in server.js, where it started) because two callers need it: the live
// /api/feedback ingest path, and the one-time backfill that repairs rows written before this
// mapper existed. Pure function — no DB, no config, safe to call from a migration.
//
// Ordering matters. 'stop' is tested before 'profit' because Meridian emits compound reasons
// like "Trailing TP: Stop loss: PnL -5.50% <= -5%" where the stop is what actually fired.

function mapExitTechnique(closeReason) {
  if (!closeReason) return null
  const r = String(closeReason).toLowerCase()
  if (r.includes('supertrend'))                                  return 'supertrend_break'
  if (r.includes('stop') || /\bsl\b/.test(r) || r.includes('emergency')) return 'il_stop'
  if (r.includes('trail'))                                       return 'trailing'
  if (r.includes('take') || r.includes('profit') || /\btp\b/.test(r) || r.includes('net target')) return 'net_target'
  if (r.includes('whale'))                                       return 'whale_exit'
  if (r.includes('low yield') || r.includes('fee/tvl'))          return 'low_yield'
  if (r.includes('rsi'))                                         return 'rsi_reversal'
  if (r.includes('pumped') || r.includes('ran up') || r.includes('above range')) return 'price_ran_up'
  if (r.includes('out of range') || r.includes('oor'))           return 'oor_timeout'
  if (r.includes('manual') || r.includes('closeall') || r.includes('management directive')) return 'manual'
  if (r.includes('limit_order_') || r.includes('auto_cancel') || r.includes('expired')) return 'lo_cancel'
  if (r.includes('max hold') || r.includes('max_hold') || r.includes('hold limit')) return 'max_hold'
  return null  // 'agent decision' and other unclassified reasons
}

module.exports = { mapExitTechnique }
