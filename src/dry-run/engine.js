'use strict'
// Dry-run READ SURFACE + position geometry. The simulator itself was removed in the Tier-A
// prune (2026-08-20): 7127 closed sims had converged on breakeven-to-negative (bid_ask -0.22%,
// spot +0.47%) while consuming an API call per open position every 5 minutes, and its exit
// labels were tautological by construction (a technique "wins" because it fires on winners).
// The un-confounded replacement is position_price_path, which records what price ACTUALLY did
// and lets any exit rule be replayed against it — see learning/exit-path-tracker.js.
//
// What remains here is read-only: getStats() for the dashboard's historical panel, and the
// pure geometry/fee helpers the Telegram alert and the tests still call. Nothing writes.
const db = require('../db/database')

// Range bins by strategy — how many bins wide a typical position is
const RANGE_BINS_BY_STRATEGY = { spot: 69, bid_ask: 34, limit_order: 10 }
// Fee window in minutes matching the screener timeframe (30m API call for snapshot)
const SNAPSHOT_TF_MINUTES = 30
// In-range efficiency factor: fraction of hold time estimated to be in active range
const IN_RANGE_FACTOR = 0.6

/**
 * Conservative LP fee estimate in PERCENTAGE POINTS (same unit as gross_pnl_pct).
 *   entryFeeRate = fee_active_tvl_ratio, a fraction (1.01 = 101% of active TVL / window).
 *   fee ≈ feeRate × (hold / window) × in-range fraction, ×100 to convert fraction → pp,
 *   then clamped to maxFeePct so an extreme/unverified pool yield can't dominate the signal.
 * Pure + exported for testing. Returns 0 when fees are disabled or inputs are missing.
 */
function computeSimulatedFeePct(entryFeeRate, holdMinutes, feeWindowMins, opts = {}) {
  const simulateFees  = opts.simulateFees !== false
  const maxFeePct     = opts.maxFeePct ?? 10
  const inRangeFactor = opts.inRangeFactor ?? IN_RANGE_FACTOR
  const haircut       = opts.haircut ?? 1   // fraction of snapshot fee-rate actually captured (reality calibration)
  if (!simulateFees || entryFeeRate == null || !(holdMinutes > 0) || !(feeWindowMins > 0)) return 0
  const raw = entryFeeRate * (holdMinutes / feeWindowMins) * inRangeFactor * haircut * 100
  const capped = Math.min(Math.max(raw, 0), maxFeePct)
  return Math.round(capped * 100) / 100
}

/**
 * Downward price range (as a fraction) that a strategy's SOL liquidity covers below entry.
 * range_bins (per strategy) × bin_step (basis points → fraction). Clamped to (0.01, 0.99).
 */
function rangePctForStrategy(strategy, binStep) {
  const bins = RANGE_BINS_BY_STRATEGY[strategy] ?? 34
  const step = (binStep > 0 ? binStep : 100) / 10000  // bin_step is in basis points; 100 bps = 1%/bin
  return Math.min(0.99, Math.max(0.01, bins * step))
}

/**
 * Single-sided SOL (quote) liquidity P&L in PERCENTAGE POINTS, relative to the initial SOL capital.
 * Meridian places SOL-only liquidity as a "bid" spread across bins from entryPrice down to
 * entryPrice × (1 − rangeFraction):
 *   - price rises (≥ entry) → SOL never converts → 0 price P&L (fees handled separately);
 *   - price dips into the range → that fraction of SOL buys the token at a below-entry average,
 *     now worth currentPrice → impermanent loss, bounded at −100% (token → 0, all SOL spent).
 * Uniform distribution is assumed (Argus has no per-bin shape; Meridian owns the real shape).
 * Pure + exported for testing.
 */
function computeSingleSidedPnlPct(entryPrice, currentPrice, rangeFraction) {
  if (!(entryPrice > 0) || !(currentPrice > 0) || !(rangeFraction > 0)) return 0
  if (currentPrice >= entryPrice) return 0
  const f = Math.min(1, (entryPrice - currentPrice) / (entryPrice * rangeFraction))  // capital converted
  const fillFloor = Math.max(currentPrice, entryPrice * (1 - rangeFraction))
  const avgFill = (entryPrice + fillFloor) / 2  // avg price the converted SOL bought token at
  return f * (currentPrice / avgFill - 1) * 100
}

function getStats() {
  const open = db.prepare(`SELECT COUNT(*) AS n FROM dry_run_positions WHERE status = 'open'`).get()
  const closed = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN net_pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
           AVG(net_pnl_pct)  AS avg_pnl,
           SUM(net_pnl_pct)  AS total_pnl,
           AVG(hold_minutes) AS avg_hold
    FROM dry_run_positions WHERE status = 'closed' AND outcome_valid = 1
  `).get()

  return {
    open_positions: open.n,
    total_closed:   closed.total || 0,
    wins:           closed.wins  || 0,
    win_rate:       closed.total > 0 ? Math.round((closed.wins / closed.total) * 100) : null,
    avg_pnl_pct:    closed.avg_pnl   != null ? Math.round(closed.avg_pnl   * 100) / 100 : null,
    total_pnl_pct:  closed.total_pnl != null ? Math.round(closed.total_pnl * 100) / 100 : null,
    avg_hold_min:   closed.avg_hold  != null ? Math.round(closed.avg_hold) : null,
  }
}

module.exports = { getStats, computeSimulatedFeePct, computeSingleSidedPnlPct, rangePctForStrategy }
