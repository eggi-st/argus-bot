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
 *   wins = open_position actions where the matched dry-run position closed profitably
 *   quality_score = (wins + 1) / (total + 2)   [Laplace smoothing → starts at 0.5]
 *
 * Only wallets with at least one matched 'followed' action get updated; others
 * keep their default 0.5 until enough data exists.
 */
function scoreWallets() {
  const rows = db.prepare(`
    SELECT
      wa.wallet_address,
      COUNT(*)                                                     AS total,
      SUM(CASE WHEN dr.net_pnl_pct > 0 THEN 1 ELSE 0 END)        AS wins
    FROM wallet_actions wa
    JOIN dry_run_positions dr
      ON  dr.pool_address  = wa.pool_address
      AND dr.status        = 'closed'
      AND dr.outcome_valid = 1
    WHERE wa.wallet_type     = 'smart_money'
      AND wa.action_type     = 'open_position'
      AND wa.match_category  = 'followed'
    GROUP BY wa.wallet_address
  `).all()

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
