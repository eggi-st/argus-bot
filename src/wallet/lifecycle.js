'use strict'
// Wallet Lifecycle Manager — state machine for tracked_wallets.
//
// States (lifecycle_state):
//   active    → seen within coolingDays (default 3d). Full observation.
//   cooling   → not seen 3–7d. Still observed; grace period.
//   stale     → not seen 7–14d. Still observed but deprioritized.
//   retired   → not seen 14+d. Removed from observer (active=0).
//
// "Seen" = last_seen updated either by hivemind re-discovery OR by the wallet
// observer detecting a real Meteora wallet_action from this address.
//
// quality_score [0,1]: fraction of this wallet's matched LP entries that led to
// a profitable Argus dry-run outcome, with Laplace smoothing (starts at 0.5).
// Used for future ranking: higher-quality wallets can receive stronger confidence
// boosts; currently computed but not yet wired to processPool.

const db  = require('../db/database')
const bus = require('../core/event-bus')
const { getConfig } = require('../config')

/**
 * Transition all wallet states based on last_seen staleness.
 * Single idempotent UPDATE covers every state in one pass.
 */
function assessLifecycles() {
  const cfg  = getConfig()
  const lCfg = cfg.wallet?.lifecycle || {}
  const coolingDays  = lCfg.coolingDays  ?? 3
  const staleDays    = lCfg.staleDays    ?? 7
  const retiredDays  = lCfg.retiredDays  ?? 14
  const minFloor     = lCfg.minActiveFloor ?? 3

  const now = Date.now()
  const coolingCutoff  = new Date(now - coolingDays  * 86_400_000).toISOString()
  const staleCutoff    = new Date(now - staleDays    * 86_400_000).toISOString()
  const retiredCutoff  = new Date(now - retiredDays  * 86_400_000).toISOString()

  const r = db.prepare(`
    UPDATE tracked_wallets
    SET
      lifecycle_state = CASE
        WHEN last_seen IS NULL OR last_seen < @retiredCutoff THEN 'retired'
        WHEN last_seen < @staleCutoff                        THEN 'stale'
        WHEN last_seen < @coolingCutoff                      THEN 'cooling'
        ELSE 'active'
      END,
      active = CASE
        WHEN last_seen IS NULL OR last_seen < @retiredCutoff THEN 0
        ELSE 1
      END
  `).run({ coolingCutoff, staleCutoff, retiredCutoff })

  // Anti-spiral floor: if retirement drained the observable pool below minFloor, rescue the
  // most-recently-seen retired wallets back to 'stale' (active=1). Without this, a single
  // upstream outage (discovery + RPC both down, as happened when one Helius key throttled)
  // retires every wallet and the observer dies permanently — nothing left to re-detect
  // activity that would revive them. Keeping a floor lets it self-heal once RPC recovers.
  if (minFloor > 0) {
    const activeCount = db.prepare(
      `SELECT COUNT(*) AS c FROM tracked_wallets WHERE lifecycle_state != 'retired'`
    ).get().c
    if (activeCount < minFloor) {
      const need = minFloor - activeCount
      const rescued = db.prepare(`
        UPDATE tracked_wallets
        SET lifecycle_state = 'stale', active = 1
        WHERE address IN (
          SELECT address FROM tracked_wallets
          WHERE lifecycle_state = 'retired' AND last_seen IS NOT NULL
          ORDER BY last_seen DESC
          LIMIT @need
        )
      `).run({ need })
      if (rescued.changes > 0) {
        console.log(`[WalletLifecycle] Anti-spiral floor: rescued ${rescued.changes} wallet(s) from retirement (pool was ${activeCount}/${minFloor})`)
      }
    }
  }

  const counts = db.prepare(
    `SELECT lifecycle_state, COUNT(*) AS n FROM tracked_wallets GROUP BY lifecycle_state`
  ).all()
  const summary = counts.map(c => `${c.lifecycle_state}=${c.n}`).join(' · ')
  console.log(`[WalletLifecycle] ${r.changes} wallet(s) updated. ${summary}`)

  // Nudge hivemind to find replacements when wallets retire
  const retiredCount = counts.find(c => c.lifecycle_state === 'retired')?.n ?? 0
  if (retiredCount > 0) {
    bus.emitSafe('tracked_wallets_updated', { retired: retiredCount })
  }

  return { changes: r.changes, counts }
}

/**
 * Compute quality_score for each smart_money wallet:
 *   wins = LP entries by this wallet followed by a profitable Argus dry-run outcome
 *          on the same pool
 *   quality_score = (wins + 1) / (total + 2)   [Laplace smoothing → starts at 0.5]
 *
 * Pairing rules (all three matter — an earlier version got each one wrong and scored
 * exactly zero wallets for a month):
 *   - action_type: the tx-parser only emits 'open_position' for InitializeLbPair, i.e.
 *     pool CREATION. Smart money LPs into existing pools, so their entries are almost
 *     always 'add_liquidity'. Filtering on 'open_position' alone matches nothing.
 *   - match_category: 'followed' means the action landed on a pool Argus happened to have
 *     an ACTIVE recommendation for — a rare coincidence, and not what quality means here.
 *     Any LP entry counts; the pool-level dry-run outcome is the label.
 *   - pairing: one wallet action must map to at most ONE dry-run position. A plain JOIN on
 *     pool_address is a cross product (a hot pool has hundreds of actions × dozens of
 *     positions) and inflates counts by ~100×. We take the FIRST position opened within
 *     qualityWindowDays AFTER the entry — the outcome that entry could plausibly predict.
 *
 * Wallets with no pairable entry keep their default 0.5 until enough data exists.
 */
function scoreWallets() {
  const cfg  = getConfig()
  const windowDays = cfg.wallet?.lifecycle?.qualityWindowDays ?? 1

  const rows = db.prepare(`
    WITH entries AS (
      SELECT wa.wallet_address AS addr, wa.detected_at AS ts, wa.pool_address AS pool
      FROM wallet_actions wa
      WHERE wa.wallet_type  = 'smart_money'
        AND wa.action_type  IN ('add_liquidity', 'open_position')
        AND wa.pool_address IS NOT NULL
    ),
    paired AS (
      SELECT e.addr,
             (SELECT dr.net_pnl_pct
                FROM dry_run_positions dr
               WHERE dr.pool_address  = e.pool
                 AND dr.status        = 'closed'
                 AND dr.outcome_valid = 1
                 AND julianday(dr.opened_at) >= julianday(e.ts)
                 AND julianday(dr.opened_at) <= julianday(e.ts) + @windowDays
               ORDER BY dr.opened_at ASC
               LIMIT 1) AS pnl
      FROM entries e
    )
    SELECT addr                                          AS wallet_address,
           COUNT(*)                                      AS total,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)      AS wins
    FROM paired
    WHERE pnl IS NOT NULL
    GROUP BY addr
  `).all({ windowDays })

  if (!rows.length) return 0

  const stmt = db.prepare(`UPDATE tracked_wallets SET quality_score = ? WHERE address = ?`)
  const tx = db.transaction(rs => {
    for (const r of rs) {
      const score = Math.round(((r.wins + 1) / (r.total + 2)) * 1000) / 1000
      stmt.run(score, r.wallet_address)
    }
  })
  tx(rows)

  const avgScore = rows.reduce((s, r) => s + (r.wins + 1) / (r.total + 2), 0) / rows.length
  console.log(`[WalletLifecycle] Scored ${rows.length} wallet(s) · avg quality=${avgScore.toFixed(2)}`)
  return rows.length
}

function runLifecycleCycle() {
  const lifecycle = assessLifecycles()
  const scored    = scoreWallets()
  return { ...lifecycle, scored }
}

function init() {
  bus.onSlow('wallet_lifecycle_check', () => {
    try { runLifecycleCycle() }
    catch (e) { console.error('[WalletLifecycle] Cycle error:', e.message) }
  })
  console.log('[WalletLifecycle] Ready')
}

module.exports = { init, runLifecycleCycle, assessLifecycles, scoreWallets }
