'use strict'
/**
 * Cold-Start Seed: import Meridian historical positions into Argus Pattern Library.
 *
 * Reads lessons.json from Meridian VPS, maps each closed position to
 * Argus pattern dimensions (volatility_bucket × regime × strategy), and
 * UPSERTs into pattern_library using the same running-average formula as
 * pattern-updater.js. Does NOT create dry_run_positions rows — writes
 * directly to pattern_library.
 *
 * Usage (on VPS):
 *   node tools/seed-from-meridian.js
 *
 * Env overrides:
 *   MERIDIAN_LESSONS=/custom/path/lessons.json
 *   ARGUS_DB=/custom/path/argus.db
 */

const path = require('path')
const fs   = require('fs')
const Database = require('better-sqlite3')

const MERIDIAN_LESSONS = process.env.MERIDIAN_LESSONS
  || path.resolve(__dirname, '../../meridian-bot/lessons.json')
const ARGUS_DB = process.env.ARGUS_DB
  || path.resolve(__dirname, '../data/argus.db')

// ── Validity gate (mirrors Meridian's isValidOutcome) ────────────────────────
function isValid(r) {
  if (!r) return false
  if (r.cf_excluded === true) return false
  if (r.close_reason === 'limit_order_expired') return false
  const h = r.minutes_held
  if (h === 0 || (h != null && h < 3)) return false
  return true
}

// ── Dimension mapping ─────────────────────────────────────────────────────────
function toVolBucket(vol) {
  if (vol > 2) return 'high'
  if (vol > 1) return 'medium'
  return 'low'
}

function toRegime(r) {
  const snap     = r.signal_snapshot || {}
  const feeTvl   = r.fee_tvl_ratio ?? 0
  const pricePct = snap.price_change_pct ?? 0
  const volPct   = snap.volume_change_pct ?? 0

  if (pricePct > 5 && volPct > 30) return 'recovery'
  if (pricePct < -5)               return 'decline'
  if (feeTvl > 0.3)                return 'froth'
  return 'neutral'
}

function toStrategy(s) {
  if (s === 'spot')         return 'spot'
  if (s === 'bid_ask')      return 'bid_ask'
  if (s === 'curve')        return 'bid_ask'   // closest Argus analog
  if (s === 'limit_order')  return 'limit_order'
  return null
}

function toNetPnlPct(r) {
  const init = r.initial_value_usd
  if (!init || init <= 0) return null

  if (r.pnl_net_usd != null && isFinite(r.pnl_net_usd)) {
    return (r.pnl_net_usd / init) * 100
  }
  if (r.pnl_usd != null && isFinite(r.pnl_usd)) {
    // No net available — subtract rough tx cost estimate (0.3% of position)
    const estCost = init * 0.003
    return ((r.pnl_usd - estCost) / init) * 100
  }
  return null
}

// ── UPSERT (same running-average formula as pattern-updater.js) ───────────────
const UPSERT_SQL = `
  INSERT INTO pattern_library
    (updated_at, volatility_bucket, regime, strategy, win_rate, mean_pnl_net, sample_count, active)
  VALUES (?, ?, ?, ?, ?, ?, 1, 0)
  ON CONFLICT(volatility_bucket, regime, strategy) DO UPDATE SET
    updated_at   = excluded.updated_at,
    win_rate     = ((win_rate * sample_count) + excluded.win_rate)     / (sample_count + 1),
    mean_pnl_net = ((mean_pnl_net * sample_count) + excluded.mean_pnl_net) / (sample_count + 1),
    sample_count = sample_count + 1,
    active       = CASE WHEN sample_count + 1 >= 20 THEN 1 ELSE active END
`

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  // Load lessons.json
  if (!fs.existsSync(MERIDIAN_LESSONS)) {
    console.error(`\nlessons.json not found: ${MERIDIAN_LESSONS}`)
    console.error('Env override: MERIDIAN_LESSONS=/path/to/lessons.json\n')
    process.exit(1)
  }

  const raw         = JSON.parse(fs.readFileSync(MERIDIAN_LESSONS, 'utf8'))
  const performance = raw.performance || []
  console.log(`\n── Argus Cold-Start Seed ──────────────────────────────`)
  console.log(`Loaded ${performance.length} records from Meridian lessons.json`)

  // Filter
  const valid = performance.filter(isValid)
  const skippedValidity = performance.length - valid.length
  console.log(`Valid after filter (cf_excluded / minHeld / LO): ${valid.length} (${skippedValidity} skipped)`)

  // Open Argus DB
  if (!fs.existsSync(ARGUS_DB)) {
    console.error(`\nArgus DB not found: ${ARGUS_DB}`)
    console.error('Is Argus running on this VPS? DB is created on first start.\n')
    process.exit(1)
  }

  const db    = new Database(ARGUS_DB)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  const upsert = db.prepare(UPSERT_SQL)
  const now    = new Date().toISOString()

  let inserted = 0, skippedMap = 0
  const buckets = {}

  for (const r of valid) {
    const vol       = r.volatility ?? 0
    const volBucket = toVolBucket(vol)
    const regime    = toRegime(r)
    const strategy  = toStrategy(r.strategy)
    const netPnlPct = toNetPnlPct(r)

    if (!strategy || netPnlPct == null || !isFinite(netPnlPct)) {
      skippedMap++
      continue
    }

    const win = netPnlPct > 0 ? 1.0 : 0.0
    const key = `${volBucket}×${regime}×${strategy}`
    buckets[key] = (buckets[key] || 0) + 1

    upsert.run(now, volBucket, regime, strategy, win, netPnlPct)
    inserted++
  }

  console.log(`\nSeeded: ${inserted} records (${skippedMap} unmappable skipped)`)

  // Bucket breakdown
  console.log('\nDistribution:')
  for (const [k, n] of Object.entries(buckets).sort()) {
    console.log(`  ${k.padEnd(35)} ${n} samples`)
  }

  // Pattern library result
  const patterns = db.prepare(`
    SELECT volatility_bucket, regime, strategy,
           sample_count, active,
           ROUND(win_rate * 100) AS wr_pct,
           ROUND(mean_pnl_net, 2) AS mean_pnl
    FROM pattern_library
    ORDER BY active DESC, sample_count DESC
  `).all()

  const active  = patterns.filter(p => p.active)
  const pending = patterns.filter(p => !p.active)
  console.log(`\nPattern Library: ${active.length} active, ${pending.length} calibrating`)

  if (active.length) {
    console.log('\n  Active (N ≥ 20):')
    for (const p of active) {
      const pnlStr = p.mean_pnl >= 0 ? `+${p.mean_pnl}%` : `${p.mean_pnl}%`
      console.log(`    ✓ ${p.volatility_bucket}×${p.regime}×${p.strategy.padEnd(12)} WR=${p.wr_pct}% avg=${pnlStr} N=${p.sample_count}`)
    }
  }
  if (pending.length) {
    console.log('\n  Calibrating (N < 20):')
    for (const p of pending) {
      console.log(`    · ${p.volatility_bucket}×${p.regime}×${p.strategy.padEnd(12)} N=${p.sample_count}/20`)
    }
  }

  console.log('\n── Done ───────────────────────────────────────────────\n')
  db.close()
}

main()
