'use strict'
const bus = require('../core/event-bus')
const db = require('../db/database')
const { recordDryRunPosition, closeDryRunPosition, recordTokenPrice } = require('../db/schema')
const { getPoolSnapshot, getDexscreenerPrice } = require('./price-feed')
const { confirmTechnique } = require('../intelligence/chart-indicators')

// Range bins by strategy — how many bins wide a typical position is
const RANGE_BINS_BY_STRATEGY = { spot: 69, bid_ask: 34, limit_order: 10 }
// Fee window in minutes matching the screener timeframe (30m API call for snapshot)
const SNAPSHOT_TF_MINUTES = 30
// In-range efficiency factor: fraction of hold time estimated to be in active range
const IN_RANGE_FACTOR = 0.6

// In-memory peak net PnL % per position (survives within a run; resets on restart — acceptable for dry-run).
// Used by trailing take-profit: position must first reach trailingTriggerPct before the drop gate arms.
const peakPnlTracker = new Map()

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

async function getPriceForPosition(tokenMint, poolAddress) {
  if (poolAddress) {
    try {
      const snap = await getPoolSnapshot(poolAddress)
      if (snap?.price != null && snap.price > 0) return snap.price
    } catch {}
  }
  if (tokenMint) {
    try {
      const d = await getDexscreenerPrice(tokenMint)
      if (d?.price_sol != null && d.price_sol > 0) return d.price_sol
    } catch {}
  }
  return null
}
const { getConfig } = require('../config')

/**
 * Open a dry run position immediately after a decision is recorded.
 * Skips if pool has no price data (can't track P&L without an entry price).
 */
function openForDecision(decisionId, pool, strategy) {
  if (!pool?.price || !pool?.base?.mint) {
    console.log(`[DryRun] Skip open for decision #${decisionId} — no price data`)
    return
  }

  // Guard: don't double-open for the same decision
  const exists = db.prepare(
    `SELECT id FROM dry_run_positions WHERE decision_id = ? LIMIT 1`
  ).get(decisionId)
  if (exists) return

  const cfg = getConfig()
  const solAmount = cfg.dryRun?.solAmount ?? 0.1

  try {
    const result = recordDryRunPosition({
      decision_id:           decisionId,
      opened_at:             new Date().toISOString(),
      token_mint:            pool.base.mint,
      token_symbol:          pool.base.symbol || null,
      pool_address:          pool.pool,
      strategy,
      entry_price_sol:       pool.price,
      entry_bin:             null,
      range_bins:            RANGE_BINS_BY_STRATEGY[strategy] ?? 34,
      sol_amount:            solAmount,
      simulated_slippage_pct: 0.3,
      tx_cost_usd:           0.002,
      entry_fee_rate:        pool.fee_active_tvl_ratio ?? null,
      fee_window_minutes:    SNAPSHOT_TF_MINUTES,
      range_pct:             rangePctForStrategy(strategy, pool.bin_step),
      // Entry-technique provenance. bid_ask/spot enter via the router gate today;
      // limit_order's bb_plus_rsi trigger is wired in Phase 3. (See techniques registry.)
      entry_technique:       pool.entry_technique ?? 'vol_feetvl_gate',
    })
    console.log(`[DryRun] Opened #${result.lastInsertRowid}: ${pool.base.symbol} → ${strategy} @ ${pool.price} SOL (${solAmount} SOL stake)`)
  } catch (e) {
    console.error(`[DryRun] Open failed for decision #${decisionId}:`, e.message)
  }
}

/**
 * Update all open positions: fetch current price, check close conditions.
 * Called every 5 minutes via dry_run_update event.
 */
async function updateOpenPositions() {
  const positions = db.prepare(`
    SELECT dr.id, dr.token_mint, dr.token_symbol, dr.pool_address, dr.strategy,
           dr.entry_price_sol, dr.opened_at, dr.simulated_slippage_pct, dr.sol_amount,
           dr.entry_fee_rate, dr.fee_window_minutes, dr.range_pct,
           d.expires_at AS decision_expires_at
    FROM dry_run_positions dr
    JOIN decisions d ON d.id = dr.decision_id
    WHERE dr.status = 'open'
  `).all()

  if (!positions.length) return

  const cfg = getConfig()
  const drCfg = cfg.dryRun || {}
  // Phase 2 — outcome-driven, single-sided-aware exits (replaces blind ttl_expired).
  // These act on the computed P&L, not the raw token move, so a price rise (which never
  // fills a SOL bid below entry) is NOT mistaken for profit.
  const netTargetPct = drCfg.netTargetPct ?? 5    // net (gross + fee − slip) ≥ this → take profit
  const ilStopPct    = drCfg.ilStopPct    ?? 15   // single-sided IL ≤ −this → stop loss
  const runUpExitPct = drCfg.runUpExitPct ?? 30   // price ran ≥ this above entry → bid dead, reclaim SOL
  const maxHoldMins  = drCfg.maxHoldMinutes ?? 240 // time-bound fallback (decoupled from short rec-TTL)

  console.log(`[DryRun] Updating ${positions.length} open position(s)`)

  for (const pos of positions) {
    try {
      // Fetch price + exit metrics in a single API call
      let currentPrice = null
      let exitSnapshot = null
      if (pos.pool_address) {
        exitSnapshot = await getPoolSnapshot(pos.pool_address)
        currentPrice = exitSnapshot?.price ?? null
      }
      if (currentPrice == null && pos.token_mint) {
        const d = await getDexscreenerPrice(pos.token_mint)
        currentPrice = d?.price_sol ?? null
      }
      if (currentPrice == null) {
        // Pool delisted from Meteora + DexScreener timeout → can't price it. Don't let it hang
        // open forever (which also blocks the time-based max_hold). Past max_hold, force-close as
        // stale with outcome_valid=0 so it's freed from the open set but EXCLUDED from learning
        // (we never observed a real outcome).
        const holdMins = Math.floor((Date.now() - new Date(pos.opened_at).getTime()) / 60_000)
        if (holdMins >= maxHoldMins) {
          closeDryRunPosition(pos.id, {
            closed_at: new Date().toISOString(), exit_price_sol: null,
            gross_pnl_pct: 0, net_pnl_pct: 0, hold_minutes: holdMins,
            close_reason: 'max_hold_no_price', exit_technique: 'max_hold',
            exit_metrics_json: JSON.stringify({ model: 'single_sided_sol', no_price: true }),
            simulated_fee_pct: 0, outcome_valid: 0,
          })
          console.log(`[DryRun] Force-closed #${pos.id} ${pos.token_symbol} at max_hold — no price (hold=${holdMins}m, excluded from learning)`)
        }
        continue
      }
      try { recordTokenPrice(pos.token_mint, currentPrice, new Date().toISOString()) } catch {}

      // Bootstrap: fill entry price if it was null at open time
      if (!pos.entry_price_sol) {
        db.prepare(`UPDATE dry_run_positions SET entry_price_sol = ? WHERE id = ?`)
          .run(currentPrice, pos.id)
        pos.entry_price_sol = currentPrice
        console.log(`[DryRun] #${pos.id} ${pos.token_symbol}: entry price set to ${currentPrice}`)
        continue  // wait for next cycle to close — just entered
      }

      const priceMovePct = ((currentPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100  // raw token move
      const holdMinutes  = Math.floor((Date.now() - new Date(pos.opened_at).getTime()) / 60_000)

      // ── Compute prospective P&L every cycle (single-sided SOL model) ──────────
      // Meridian deploys SOL-only liquidity as a "bid" in bins BELOW entry:
      //   price rises → SOL never converts → 0 price P&L (fees only);
      //   price dips into range → that fraction of SOL buys the token below entry → IL.
      const feeWindowMins = pos.fee_window_minutes ?? SNAPSHOT_TF_MINUTES
      const rangeFraction = pos.range_pct ?? rangePctForStrategy(pos.strategy, null)
      const grossPnlPct   = computeSingleSidedPnlPct(pos.entry_price_sol, currentPrice, rangeFraction)
      // Fill fraction = share of SOL that actually swapped into the token (0 when price stayed
      // above entry — the bid never filled). Drives BOTH fee income and slippage.
      const fillFraction  = (currentPrice < pos.entry_price_sol)
        ? Math.min(1, (pos.entry_price_sol - currentPrice) / (pos.entry_price_sol * rangeFraction))
        : 0
      const simulatedFeePct = computeSimulatedFeePct(
        pos.entry_fee_rate ?? null, holdMinutes, feeWindowMins,
        { simulateFees: drCfg.simulateFees, maxFeePct: drCfg.maxSimulatedFeePct,
          inRangeFactor: fillFraction, haircut: drCfg.feeCaptureHaircut ?? 1 }
      )
      // SLIPPAGE REALISM (Phase 2): only the SOL that actually swapped pays slippage. A bid that
      // never fills (price ran up) costs ~0 — NOT the old flat 0.6% that floored every no-fill at −0.6%.
      const slipCost       = (pos.simulated_slippage_pct ?? 0.3) * 2 * fillFraction
      const finalNetPnlPct = grossPnlPct + simulatedFeePct - slipCost

      // ── Peak PnL tracking (trailing stop reference, Meridian-adapted) ────────
      const trackedPeak = peakPnlTracker.get(pos.id) ?? finalNetPnlPct
      const currentPeak = Math.max(trackedPeak, finalNetPnlPct)
      peakPnlTracker.set(pos.id, currentPeak)

      // ── Outcome-driven exit decision (recorded as exit_technique) ─────────────
      // Priority order (mirrors Meridian): hard limits → trailing TP → indicator signals → max_hold.
      // Acts on computed P&L, not raw price move — a price rise never "profits" a SOL bid below entry.
      let closeReason = null, exitTechnique = null, indicatorSignal = null

      // 1. Hard exits — fire regardless of anything else
      if      (finalNetPnlPct >= netTargetPct)    { closeReason = 'take_profit';  exitTechnique = 'net_target' }
      else if (grossPnlPct    <= -ilStopPct)      { closeReason = 'stop_loss';    exitTechnique = 'il_stop' }
      else if (priceMovePct   >= runUpExitPct)    { closeReason = 'price_ran_up'; exitTechnique = 'price_ran_up' }

      // 2. Trailing take-profit — arms once position reaches trailingTriggerPct, closes on pullback
      const trailingTriggerPct = drCfg.trailingTriggerPct ?? 3.0  // arm when net PnL reaches +3%
      const trailingDropPct    = drCfg.trailingDropPct    ?? 1.5  // close if drops ≥1.5pp from peak
      if (!closeReason && currentPeak >= trailingTriggerPct) {
        const dropFromPeak = currentPeak - finalNetPnlPct
        if (dropFromPeak >= trailingDropPct) { closeReason = 'trailing_tp'; exitTechnique = 'trailing_tp' }
      }

      // 3. Indicator-based exit (RSI overbought / supertrend bearish / bollinger upper)
      // Meridian reference: evaluatePreset('exit', exitPreset, payload). Fires pre-max_hold so
      // the learning system can attribute exits to concrete signals rather than time-expiry.
      // Strategy logic: bid_ask bids sit BELOW price; a bearish indicator means price will fall
      // INTO our range (desirable) — so for bid_ask only check when IL is already accruing.
      // For spot/limit_order: check when price has run up and fees are at risk of being erased by IL.
      const indicatorsCfg = cfg.indicators || {}
      const minHoldForIndicator = drCfg.minHoldBeforeIndicatorCheck ?? 20
      if (!closeReason && indicatorsCfg.enabled && indicatorsCfg.exitPreset && holdMinutes >= minHoldForIndicator) {
        const shouldCheck = pos.strategy === 'bid_ask'
          ? priceMovePct < 0    // bid_ask: only exit on bearish signal when IL is actively accruing
          : priceMovePct >= 0   // spot/LO: protect accrued fees before a price reversal causes IL
        if (shouldCheck) {
          const ivl = (Array.isArray(indicatorsCfg.intervals) && indicatorsCfg.intervals[0]) || '15_MINUTE'
          try {
            const result = await confirmTechnique(pos.token_mint, indicatorsCfg.exitPreset, 'exit', ivl)
            if (!result.skipped && result.confirmed) {
              closeReason = 'indicator_exit'
              exitTechnique = result.technique
              indicatorSignal = { preset: result.technique, reason: result.reason, author: result.author }
            }
          } catch (indErr) {
            // indicators unavailable → hold; pattern-learning still records the unclosed position
            console.warn(`[DryRun] #${pos.id} indicator check failed (hold): ${indErr.message}`)
          }
        }
      }

      // 4. Time-bound fallback — decoupled from recommendation TTL
      if (!closeReason && holdMinutes >= maxHoldMins) { closeReason = 'max_hold'; exitTechnique = 'max_hold' }

      if (closeReason) {
        peakPnlTracker.delete(pos.id)
        closeDryRunPosition(pos.id, {
          closed_at:          new Date().toISOString(),
          exit_price_sol:     currentPrice,
          gross_pnl_pct:      Math.round(grossPnlPct     * 100) / 100,
          net_pnl_pct:        Math.round(finalNetPnlPct  * 100) / 100,
          hold_minutes:       holdMinutes,
          close_reason:       closeReason,
          exit_technique:     exitTechnique,
          exit_metrics_json:  JSON.stringify({
            ...(exitSnapshot || {}),
            price_move_pct: Math.round(priceMovePct  * 100) / 100,
            fill_fraction:  Math.round(fillFraction  * 100) / 100,
            slip_cost_pct:  Math.round(slipCost      * 100) / 100,
            range_pct:      rangeFraction,
            peak_pnl_pct:   Math.round(currentPeak   * 100) / 100,
            model:          'single_sided_sol',
            ...(indicatorSignal ? { indicator: indicatorSignal } : {}),
          }),
          simulated_fee_pct:  simulatedFeePct,
        })

        const dir = priceMovePct >= 0 ? '▲' : '▼'
        const feeStr = simulatedFeePct > 0 ? ` fee=+${simulatedFeePct.toFixed(2)}%` : ''
        const peakStr = currentPeak > 0 ? ` peak=${currentPeak.toFixed(2)}%` : ''
        const indStr = indicatorSignal ? ` [${indicatorSignal.preset}]` : ''
        console.log(`[DryRun] Closed #${pos.id} ${pos.token_symbol} price${dir}${Math.abs(priceMovePct).toFixed(2)}% → pos=${grossPnlPct.toFixed(2)}% net=${finalNetPnlPct.toFixed(2)}%${feeStr}${peakStr} (${closeReason}${indStr}, hold=${holdMinutes}m)`)

        bus.emitSafe('outcome_recorded', {
          position_id:       pos.id,
          token_symbol:      pos.token_symbol,
          strategy:          pos.strategy,
          gross_pnl_pct:     Math.round(grossPnlPct    * 100) / 100,
          net_pnl_pct:       Math.round(finalNetPnlPct * 100) / 100,
          simulated_fee_pct: simulatedFeePct,
          hold_minutes:      holdMinutes,
          close_reason:      closeReason,
          win:               finalNetPnlPct > 0,
        })

        bus.emitSafe('ui_update', {
          type:              'dry_run_closed',
          token_symbol:      pos.token_symbol,
          strategy:          pos.strategy,
          net_pnl_pct:       Math.round(finalNetPnlPct * 100) / 100,
          simulated_fee_pct: simulatedFeePct,
          close_reason:      closeReason,
        })
      }
    } catch (e) {
      console.error(`[DryRun] Update error for #${pos.id} ${pos.token_symbol}:`, e.message)
    }
  }
}

/**
 * Summary stats for the dashboard.
 */
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

/**
 * Startup bootstrap:
 * 1. Expire any decisions past their TTL (catches stale decisions from previous runs).
 * 2. Open dry run positions for active decisions that don't have one yet.
 */
function bootstrap() {
  // Expire overdue decisions
  const expired = db.prepare(
    `UPDATE decisions SET status = 'expired' WHERE status = 'active' AND expires_at < ?`
  ).run(new Date().toISOString())
  if (expired.changes > 0) console.log(`[DryRun] Bootstrap: expired ${expired.changes} stale decision(s)`)

  // Open dry run positions for active decisions that lack one
  const orphaned = db.prepare(`
    SELECT d.id, d.token_mint, d.token_symbol, d.pool_address, d.strategy
    FROM decisions d
    LEFT JOIN dry_run_positions dr ON dr.decision_id = d.id
    WHERE d.status = 'active' AND dr.id IS NULL
  `).all()

  for (const dec of orphaned) {
    // We have no live pool.price here — fetch from price-feed synchronously isn't possible.
    // Mark these as needing price discovery; they'll be handled on next dry_run_update.
    // For now open with entry_price_sol = null (outcome_valid will stay 0 until price confirmed).
    try {
      const cfg = getConfig()
      const result = recordDryRunPosition({
        decision_id:            dec.id,
        opened_at:              new Date().toISOString(),
        token_mint:             dec.token_mint,
        token_symbol:           dec.token_symbol,
        pool_address:           dec.pool_address,
        strategy:               dec.strategy,
        entry_price_sol:        null,   // filled on first update
        entry_bin:              null,
        range_bins:             RANGE_BINS_BY_STRATEGY[dec.strategy] ?? 34,
        sol_amount:             cfg.dryRun?.solAmount ?? 0.1,
        simulated_slippage_pct: 0.3,
        tx_cost_usd:            0.002,
        entry_fee_rate:         null,   // not available at bootstrap — filled later if possible
        fee_window_minutes:     SNAPSHOT_TF_MINUTES,
        range_pct:              rangePctForStrategy(dec.strategy, null),
        entry_technique:        'vol_feetvl_gate',
      })
      console.log(`[DryRun] Bootstrap: opened position for orphaned decision #${dec.id} (${dec.token_symbol})`)
    } catch (e) {
      if (!e.message.includes('UNIQUE')) console.error('[DryRun] Bootstrap open failed:', e.message)
    }
  }
}

function init() {
  bootstrap()

  bus.onSlow('dry_run_update', () => {
    updateOpenPositions().catch(e => console.error('[DryRun] Update cycle failed:', e.message))
  })
  console.log('[DryRun] Dry Run Engine ready')
}

module.exports = { init, openForDecision, updateOpenPositions, getStats, computeSimulatedFeePct, computeSingleSidedPnlPct, rangePctForStrategy }
