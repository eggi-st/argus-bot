'use strict'
/**
 * Backfill Meridian's historical closed positions into Argus as LIVE feedback.
 *
 * WHY: Argus only ever received NEW Meridian closes (post-Phase-5). Meridian has months of
 * real closed positions sitting in lessons.json (data.performance[]) that never reached Argus.
 * Replaying them gives Argus a real-execution base immediately instead of waiting weeks.
 *
 * It POSTs each historical close to Argus's /api/feedback — the SAME endpoint live closes use,
 * so Spot-LO mapping, technique attribution, and dedup all apply identically. A stable
 * outcome_id (pool:deployed_at) makes re-runs idempotent (already-imported closes are ignored).
 *
 * Honest limits of OLD history:
 *   • no entry_technique on old entries → Argus attributes them to 'meridian_screener'
 *   • no position_type on old entries → old Spot LO can't be split from spot (going forward it can)
 *
 * Run (on the VPS, from the argus repo dir):
 *   node scripts/backfill-meridian.js                              (DRY RUN — counts + sample payload)
 *   node scripts/backfill-meridian.js --apply                      (POST all to localhost:4000)
 *   LESSONS=~/meridian-bot/lessons.json ARGUS=http://localhost:4000 node scripts/backfill-meridian.js --apply
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const apply = process.argv.includes('--apply')
const ARGUS = process.env.ARGUS || 'http://localhost:4000'
const LESSONS = (process.env.LESSONS || '~/meridian-bot/lessons.json').replace(/^~/, os.homedir())

function loadPerf() {
  if (!fs.existsSync(LESSONS)) {
    console.error(`lessons.json not found at: ${LESSONS}\nSet LESSONS=/path/to/lessons.json`)
    process.exit(1)
  }
  const data = JSON.parse(fs.readFileSync(LESSONS, 'utf8'))
  return Array.isArray(data.performance) ? data.performance : []
}

// Map one stored performance entry → the /api/feedback payload Meridian's live relay sends.
function toPayload(p) {
  const pool = p.pool
  const pnl = p.pnl_pct ?? p.pnlPct
  if (!pool || pnl == null) return null
  return {
    source: 'meridian',
    pool_address: pool,
    strategy: p.strategy || 'spot',
    pnl_pct: Number(pnl),
    fees_earned_usd: p.fees_earned_usd ?? null,
    minutes_held: p.minutes_held ?? null,
    close_reason: p.close_reason ?? null,
    volatility: p.volatility ?? p.signal_snapshot?.volatility ?? null,
    fee_tvl_ratio: p.fee_tvl_ratio ?? p.signal_snapshot?.fee_tvl_ratio ?? null,
    price_change_pct: p.price_change_pct ?? null,
    volume_change_pct: p.volume_change_pct ?? null,
    entry_technique: p.entry_technique ?? null,        // old entries: null → 'meridian_screener'
    position_type: p.position_type ?? null,            // old entries: null → can't split Spot LO
    token_symbol: (p.pool_name || '').split('-')[0] || null,
    outcome_id: `${pool}:${p.deployed_at || p.recorded_at || ''}`,   // stable → dedup on re-run
  }
}

async function main() {
  const perf = loadPerf()
  const payloads = perf.map(toPayload).filter(Boolean)
  const byStrat = {}
  for (const p of payloads) { byStrat[p.strategy] = (byStrat[p.strategy] || 0) + 1 }

  console.log('Meridian → Argus backfill')
  console.log('=========================')
  console.log(`lessons.json: ${LESSONS}`)
  console.log(`Argus:        ${ARGUS}`)
  console.log(`performance entries: ${perf.length}  →  valid payloads: ${payloads.length}`)
  console.log('by strategy:', JSON.stringify(byStrat))
  const withTech = payloads.filter(p => p.entry_technique).length
  const withPType = payloads.filter(p => p.position_type).length
  console.log(`with entry_technique: ${withTech}  |  with position_type: ${withPType}  (old entries lack both)`)

  if (!payloads.length) { console.log('\nNothing to backfill.'); return }

  if (!apply) {
    console.log('\nDRY RUN — nothing sent. Sample payload (verify the field mapping):')
    console.log(JSON.stringify(payloads[payloads.length - 1], null, 2))
    console.log('\nRe-run with --apply to POST all to', ARGUS + '/api/feedback')
    return
  }

  const DELAY = Number(process.env.DELAY || 40)
  const ROUNDS = Number(process.env.ROUNDS || 6)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const postOnce = async (body) => {
    const res = await fetch(`${ARGUS}/api/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const text = await res.text().catch(() => '')
    let j = {}; try { j = JSON.parse(text) } catch {}
    return { ok: res.ok, status: res.status, j, text }
  }

  // Convergent retry: items that fail (e.g. during a 15-min scan window when the single-threaded
  // server briefly can't accept connections) are retried in later rounds, with a pause between
  // rounds so the scan finishes. Idempotent on outcome_id, so retries never double-count.
  let ok = 0, dup = 0
  let pending = payloads.slice()
  let lastFails = []
  for (let round = 1; round <= ROUNDS && pending.length; round++) {
    const stillFailed = []
    lastFails = []
    for (const body of pending) {
      let r
      try { r = await postOnce(body) } catch (e) { r = { ok: false, status: 0, text: e.message } }
      if (r.ok) { ok++; if (r.j.deduped || r.j.pattern_updated === false) dup++ }
      else { stillFailed.push(body); if (lastFails.length < 5) lastFails.push({ pool: body.pool_address?.slice(0, 8), status: r.status, body: (r.text || '').slice(0, 120) }) }
      if (DELAY) await sleep(DELAY)
    }
    console.log(`round ${round}: ${pending.length - stillFailed.length} landed, ${stillFailed.length} still failing`)
    if (!stillFailed.length) { pending = []; break }
    if (stillFailed.length === pending.length && round > 1) { console.log('no progress this round — server likely down; stopping'); pending = stillFailed; break }
    pending = stillFailed
    if (pending.length) await sleep(3000)   // let any in-progress scan finish before the next round
  }

  console.log(`\nDONE. ok=${ok} (already-present dedup=${dup})  unresolved=${pending.length}`)
  if (pending.length) {
    console.log('still-failing sample (status + body):'); lastFails.forEach(f => console.log('  ', JSON.stringify(f)))
    console.log(`Re-run the same command — idempotent; the ${pending.length} unresolved will retry, everything else dedups.`)
  } else {
    console.log('All entries landed. Check feedback_outcomes + the Technique Attribution "live" column.')
  }
}

main().catch(e => { console.error('backfill error:', e.message); process.exit(1) })
