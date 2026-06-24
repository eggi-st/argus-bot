'use strict'
const bus = require('../core/event-bus')
const db = require('../db/database')
const { recordDryRunPosition, closeDryRunPosition } = require('../db/schema')
const { getPriceForPosition } = require('./price-feed')
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
      decision_id: decisionId,
      opened_at: new Date().toISOString(),
      token_mint: pool.base.mint,
      token_symbol: pool.base.symbol || null,
      pool_address: pool.pool,
      strategy,
      entry_price_sol: pool.price,
      entry_bin: null,
      range_bins: 14,
      sol_amount: solAmount,
      simulated_slippage_pct: 0.3,
      tx_cost_usd: 0.002,
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
           d.expires_at AS decision_expires_at
    FROM dry_run_positions dr
    JOIN decisions d ON d.id = dr.decision_id
    WHERE dr.status = 'open'
  `).all()

  if (!positions.length) return

  const cfg = getConfig()
  const stopLoss     = -(cfg.dryRun?.stopLossPct     ?? 20)
  const takeProfit   =  (cfg.dryRun?.takeProfitPct   ?? 50)
  const maxHoldMins  =  (cfg.dryRun?.maxHoldMinutes  ?? 240)

  console.log(`[DryRun] Updating ${positions.length} open position(s)`)

  for (const pos of positions) {
    try {
      const currentPrice = await getPriceForPosition(pos.token_mint, pos.pool_address)
      if (currentPrice == null) continue

      // Bootstrap: fill entry price if it was null at open time
      if (!pos.entry_price_sol) {
        db.prepare(`UPDATE dry_run_positions SET entry_price_sol = ? WHERE id = ?`)
          .run(currentPrice, pos.id)
        pos.entry_price_sol = currentPrice
        console.log(`[DryRun] #${pos.id} ${pos.token_symbol}: entry price set to ${currentPrice}`)
        continue  // wait for next cycle to close — just entered
      }

      const grossPnlPct  = ((currentPrice - pos.entry_price_sol) / pos.entry_price_sol) * 100
      const holdMinutes  = Math.floor((Date.now() - new Date(pos.opened_at).getTime()) / 60_000)
      const decExpired   = pos.decision_expires_at && new Date(pos.decision_expires_at) < new Date()
      const slipBothWays = (pos.simulated_slippage_pct ?? 0.3) * 2
      const netPnlPct    = grossPnlPct - slipBothWays

      const closeReason =
        stopLoss    != null && grossPnlPct < stopLoss   ? 'stop_loss'    :
        takeProfit  != null && grossPnlPct > takeProfit ? 'take_profit'  :
        holdMinutes > maxHoldMins                        ? 'max_hold'     :
        decExpired                                       ? 'ttl_expired'  :
        null

      if (closeReason) {
        closeDryRunPosition(pos.id, {
          closed_at:       new Date().toISOString(),
          exit_price_sol:  currentPrice,
          gross_pnl_pct:   Math.round(grossPnlPct  * 100) / 100,
          net_pnl_pct:     Math.round(netPnlPct    * 100) / 100,
          hold_minutes:    holdMinutes,
        })

        const dir = grossPnlPct >= 0 ? '▲' : '▼'
        console.log(`[DryRun] Closed #${pos.id} ${pos.token_symbol} ${dir}${Math.abs(grossPnlPct).toFixed(2)}% net=${netPnlPct.toFixed(2)}% (${closeReason}, hold=${holdMinutes}m)`)

        bus.emitSafe('outcome_recorded', {
          position_id:  pos.id,
          token_symbol: pos.token_symbol,
          strategy:     pos.strategy,
          gross_pnl_pct: Math.round(grossPnlPct  * 100) / 100,
          net_pnl_pct:   Math.round(netPnlPct    * 100) / 100,
          hold_minutes:  holdMinutes,
          close_reason:  closeReason,
          win:           netPnlPct > 0,
        })

        bus.emitSafe('ui_update', {
          type: 'dry_run_closed',
          token_symbol: pos.token_symbol,
          strategy:     pos.strategy,
          net_pnl_pct:  Math.round(netPnlPct * 100) / 100,
          close_reason: closeReason,
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
        decision_id: dec.id,
        opened_at: new Date().toISOString(),
        token_mint: dec.token_mint,
        token_symbol: dec.token_symbol,
        pool_address: dec.pool_address,
        strategy: dec.strategy,
        entry_price_sol: null,   // will be filled on first update with confirmed price
        entry_bin: null,
        range_bins: 14,
        sol_amount: cfg.dryRun?.solAmount ?? 0.1,
        simulated_slippage_pct: 0.3,
        tx_cost_usd: 0.002,
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

module.exports = { init, openForDecision, updateOpenPositions, getStats }
