'use strict'
/**
 * Reset Argus's learning substrate after the Phase-0 P&L fix.
 *
 * WHY: every closed position before the fee fix recorded net_pnl_pct as a price-direction
 * proxy (fees were dead code), so pattern_library learned from a broken metric. This wipes
 * that so learning restarts on the corrected (price + capped-fee − slippage) metric.
 *
 * Clears:  pattern_library (the learned model), dry_run_positions (per-trade outcomes that
 *          feed + will be reconciled into learning), and expires any active decisions so
 *          bootstrap does not re-open stale price-only-era positions.
 * Keeps:   decisions history, screening_rejections (needed for Phase-3 self-diagnosis),
 *          blacklist, wallet_actions.
 *
 * Run:  node scripts/reset-learning.js          (prints what it WOULD do — dry run)
 *       node scripts/reset-learning.js --apply  (actually performs the reset)
 *
 * Run the IDENTICAL command on the VPS to reset it there.
 */
const db = require('../src/db/database')

const apply = process.argv.includes('--apply')

function count(sql, ...args) {
  try { return db.prepare(sql).get(...args)?.n ?? 0 } catch { return 0 }
}

const before = {
  pattern_library: count('SELECT COUNT(*) n FROM pattern_library'),
  dry_run_positions: count('SELECT COUNT(*) n FROM dry_run_positions'),
  dry_run_closed: count(`SELECT COUNT(*) n FROM dry_run_positions WHERE status='closed'`),
  active_decisions: count(`SELECT COUNT(*) n FROM decisions WHERE status='active'`),
  decisions_total: count('SELECT COUNT(*) n FROM decisions'),
  screening_rejections: count('SELECT COUNT(*) n FROM screening_rejections'),
}

console.log('Argus learning reset')
console.log('====================')
console.log('Current counts:')
for (const [k, v] of Object.entries(before)) console.log(`  ${k.padEnd(22)} ${v}`)

if (!apply) {
  console.log('\nDRY RUN — nothing changed. Re-run with --apply to execute:')
  console.log('  • DELETE FROM pattern_library      (-' + before.pattern_library + ')')
  console.log('  • DELETE FROM dry_run_positions    (-' + before.dry_run_positions + ')')
  console.log("  • UPDATE decisions SET status='expired' WHERE status='active'  (-" + before.active_decisions + ' active)')
  console.log('  • KEEP decisions history, screening_rejections, blacklist, wallet_actions')
  process.exit(0)
}

const tx = db.transaction(() => {
  db.prepare('DELETE FROM pattern_library').run()
  db.prepare('DELETE FROM dry_run_positions').run()
  db.prepare(`UPDATE decisions SET status='expired' WHERE status='active'`).run()
})
tx()
try { db.exec('VACUUM') } catch {}

const after = {
  pattern_library: count('SELECT COUNT(*) n FROM pattern_library'),
  dry_run_positions: count('SELECT COUNT(*) n FROM dry_run_positions'),
  active_decisions: count(`SELECT COUNT(*) n FROM decisions WHERE status='active'`),
  decisions_total: count('SELECT COUNT(*) n FROM decisions'),
  screening_rejections: count('SELECT COUNT(*) n FROM screening_rejections'),
}

console.log('\nAPPLIED. New counts:')
for (const [k, v] of Object.entries(after)) console.log(`  ${k.padEnd(22)} ${v}`)
console.log('\nLearning will now rebuild from the corrected P&L metric as new positions close.')
