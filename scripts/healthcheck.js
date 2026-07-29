'use strict'
/**
 * Post-deploy health check. Run from the repo root on the machine Argus runs on:
 *
 *   node scripts/healthcheck.js
 *
 * Read-only. Verifies that the schema migrations landed, that cross-strategy normalisation is
 * actually being applied to new decisions, and that the gate feedback loop is recording. Every
 * line ends in OK / WAIT / FAIL so nothing has to be interpreted by eye — WAIT means a
 * scheduled job simply has not run yet, which is not a problem.
 */
const path = require('path')
const DB_PATH = path.join(__dirname, '..', 'data', 'argus.db')

let db
try {
  db = require('better-sqlite3')(DB_PATH, { readonly: true })
} catch (e) {
  console.error('Cannot open ' + DB_PATH + ': ' + e.message)
  process.exit(1)
}

const one = (s, ...a) => { try { return db.prepare(s).get(...a) } catch (e) { return { ERR: e.message } } }
const all = (s, ...a) => { try { return db.prepare(s).all(...a) } catch (e) { return null } }

let fails = 0
function report(label, status, detail) {
  if (status === 'FAIL') fails++
  console.log('  [' + status.padEnd(4) + '] ' + String(label).padEnd(29) + ' ' + (detail || ''))
}

console.log('\n=== MIGRASI (harus selesai saat boot) ===')

const ex = one('SELECT COUNT(*) total, SUM(exit_technique IS NOT NULL) isi FROM feedback_outcomes')
if (ex.ERR) report('exit_technique', 'FAIL', ex.ERR)
else {
  const pct = ex.total ? (100 * ex.isi / ex.total) : 0
  report('exit_technique', pct >= 95 ? 'OK' : 'FAIL', ex.isi + '/' + ex.total + ' (' + pct.toFixed(1) + '%) — target >95%')
}

const rs = one('SELECT COUNT(*) total, SUM(raw_score IS NOT NULL) isi FROM decisions')
if (rs.ERR) report('raw_score', 'FAIL', rs.ERR + ' — kolom belum ada, migrasi gagal')
else report('raw_score', rs.isi > 0 ? 'OK' : 'FAIL', rs.isi + '/' + rs.total + ' terisi (backfill dari trace)')

const uv = one("SELECT COUNT(*) c FROM decisions WHERE condition_bucket LIKE 'unknown_vol%'")
report('relabel unknown_vol', uv.ERR ? 'FAIL' : 'OK', uv.ERR || (uv.c + ' baris dipindah dari low_vol'))

const gq = one('SELECT COUNT(*) c FROM gate_queries')
report('tabel gate_queries', gq.ERR ? 'FAIL' : 'OK', gq.ERR || 'ada')

console.log('\n=== JOB TERJADWAL (WAIT = belum waktunya, bukan masalah) ===')

const src = all('SELECT source FROM discovery_sources')
if (!src) report('discovery_sources', 'FAIL', 'tabel tidak terbaca')
else {
  const dead = src.map(r => r.source).filter(s => s === 'okx' || s === 'solscan')
  report('source mati dibersihkan', dead.length ? 'WAIT' : 'OK',
    dead.length ? 'masih ada: ' + dead.join(', ') + ' — hilang saat siklus hivemind (tiap 6j)' : 'okx & solscan sudah hilang')
}

const pf = one('SELECT maturity, overdispersion, p_value, peak_concurrency FROM portfolio_risk WHERE id=1')
if (!pf) report('portfolio observatory', 'WAIT', 'belum jalan — cron tiap 6 jam')
else if (pf.ERR) report('portfolio observatory', 'FAIL', pf.ERR)
else report('portfolio observatory', 'OK', 'maturity=' + pf.maturity + ' ratio=' + pf.overdispersion + ' p=' + pf.p_value)

console.log('\n=== NORMALISASI LINTAS-STRATEGI (inti perbaikan) ===')

const recent = all("SELECT strategy, confidence, raw_score, confidence_trace_json j FROM decisions WHERE created_at >= datetime('now','-1 day') ORDER BY id DESC LIMIT 20") || []
const withNorm = recent.filter(r => {
  try { return JSON.parse(r.j || '[]').some(s => s.step === 'cross_strategy_norm') } catch (e) { return false }
})
if (recent.length === 0) {
  report('diterapkan ke decision baru', 'WAIT', 'belum ada decision dalam 24 jam — scan tiap 15 menit')
} else {
  report('diterapkan ke decision baru', withNorm.length > 0 ? 'OK' : 'FAIL',
    withNorm.length + '/' + recent.length + ' decision terbaru punya langkah cross_strategy_norm')
}

console.log('\n  confidence per strategi, 24 jam terakhir (spot yang paling penting):')
const rows = all("SELECT strategy, COUNT(*) n, ROUND(AVG(confidence),3) avg_conf, SUM(confidence>=0.75) lolos FROM decisions WHERE created_at >= datetime('now','-1 day') GROUP BY strategy") || []
if (rows.length === 0) console.log('    (belum ada decision dalam 24 jam)')
for (const r of rows) {
  console.log('    ' + String(r.strategy).padEnd(12) + ' n=' + String(r.n).padStart(4) +
    '  avg=' + String(r.avg_conf).padStart(6) + '  lolos 0.75: ' + r.lolos)
}
console.log('    → sebelum perbaikan, spot lolos 0.75 hampir nol mutlak (1.4%)')

console.log('\n=== LOOP UMPAN BALIK GERBANG ===')
if (gq.ERR) report('gate_queries', 'FAIL', gq.ERR)
else if (gq.c === 0) report('pertanyaan tercatat', 'WAIT', '0 — gerbang hanya dipanggil saat Meridian deploy posisi (~4.6/hari)')
else {
  const linked = one('SELECT SUM(outcome_id IS NOT NULL) c FROM gate_queries')
  const conf = one('SELECT SUM(confidence IS NOT NULL) c FROM gate_queries')
  report('pertanyaan tercatat', 'OK', gq.c + ' kueri')
  report('punya nilai confidence', conf.c > 0 ? 'OK' : 'FAIL', conf.c + '/' + gq.c + ' — sebelumnya hanya 21%')
  report('outcome tertaut', linked.c > 0 ? 'OK' : 'WAIT', linked.c + '/' + gq.c + ' — tertaut saat posisi ditutup')
}

console.log('\n' + (fails === 0 ? 'Tidak ada kegagalan.' : fails + ' PEMERIKSAAN GAGAL — lihat baris [FAIL] di atas.') + '\n')
process.exit(fails === 0 ? 0 : 1)
