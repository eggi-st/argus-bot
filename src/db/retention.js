'use strict'
// DB retention — bounded growth for the pure-diagnostic tables.
//
// Argus writes one screening_rejections row per pool filtered out per scan: ~2.8k rows/day,
// ~900 KB/day. On the VPS this table reached 28 MB of a 50 MB database in a month, and nothing
// ever deleted from it. Everything that READS it looks at a short window — self-diagnosis uses
// learning.diagnosis.windowHours (24h) and the dashboard passes its own `since` — so rows past
// keepDays are dead weight that only slows the scanned_at index.
//
// Deliberately NOT pruned: decisions, dry_run_positions, feedback_outcomes, wallet_actions.
// Those are the learning corpus; pattern reconciliation and the regime observatory recompute
// over 90-day windows and would silently lose edge if trimmed.

const db  = require('../db/database')
const bus = require('../core/event-bus')
const { getConfig } = require('../config')

/**
 * Delete diagnostic rows older than keepDays.
 * Returns { screening_rejections: <deleted> } — 0 when retention is disabled.
 */
function pruneOldRows() {
  const rCfg = getConfig().retention || {}
  if (rCfg.enabled === false) return { screening_rejections: 0 }

  const keepDays = rCfg.screeningRejectionsDays ?? 30
  if (!(keepDays > 0)) return { screening_rejections: 0 }

  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString()
  const res = db.prepare(`DELETE FROM screening_rejections WHERE scanned_at < ?`).run(cutoff)

  // gate_queries is written on every question Meridian asks, so it grows with poll frequency
  // rather than with anything meaningful. Kept longer than the rejections because a linked row
  // IS learning data — and rows that never got an outcome attached are dropped first.
  const gateDays = rCfg.gateQueriesDays ?? 180
  if (gateDays > 0) {
    const gateCutoff = new Date(Date.now() - gateDays * 86_400_000).toISOString()
    const g = db.prepare(
      `DELETE FROM gate_queries WHERE created_at < ? AND outcome_id IS NULL`
    ).run(gateCutoff)
    if (g.changes > 0) console.log(`[Retention] Pruned ${g.changes} unlinked gate_queries row(s) older than ${gateDays}d`)
  }

  // position_price_path is the substrate for counterfactual exit replay, so it is kept on its
  // own (longer) clock rather than the diagnostic one.
  const pathDays = getConfig().exitIntel?.retentionDays ?? 90
  if (pathDays > 0) {
    const pathCutoff = new Date(Date.now() - pathDays * 86_400_000).toISOString()
    try {
      const p = db.prepare(`DELETE FROM position_price_path WHERE observed_at < ?`).run(pathCutoff)
      if (p.changes > 0) console.log(`[Retention] Pruned ${p.changes} price-path row(s) older than ${pathDays}d`)
    } catch (e) { console.warn('[Retention] price-path prune:', e.message) }
  }

  if (res.changes > 0) {
    console.log(`[Retention] Pruned ${res.changes} screening_rejections row(s) older than ${keepDays}d`)
    // Reclaim the freed pages instead of leaving the file at its high-water mark.
    // incremental_vacuum is a no-op unless auto_vacuum=INCREMENTAL was set at creation, so
    // fall back to a full VACUUM only when explicitly asked (it rewrites the whole DB).
    try {
      if (rCfg.vacuum === 'full') db.exec('VACUUM')
      else db.pragma('incremental_vacuum')
    } catch (e) {
      console.warn('[Retention] Vacuum skipped:', e.message)
    }
  }

  return { screening_rejections: res.changes }
}

function init() {
  bus.onSlow('retention_prune', () => {
    try { pruneOldRows() }
    catch (e) { console.error('[Retention] Prune error:', e.message) }
  })
  console.log('[Retention] Ready')
}

module.exports = { init, pruneOldRows }
