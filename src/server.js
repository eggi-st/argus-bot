'use strict'
const express = require('express')
const { WebSocketServer } = require('ws')
const http = require('http')
const path = require('path')
const crypto = require('crypto')
const bus = require('./core/event-bus')
const riskState = require('./core/risk-state')
const scheduler = require('./core/scheduler')

const app = express()
const PORT = parseInt(process.env.PORT || '4000')
const HOST = process.env.HOST || '127.0.0.1'
const WEB_PASSWORD = process.env.WEB_PASSWORD || ''
const AUTH_TOKEN = WEB_PASSWORD
  ? crypto.createHash('sha256').update(WEB_PASSWORD + 'argus').digest('hex').slice(0, 32)
  : null

if (!WEB_PASSWORD) console.warn('[WEB] WARNING: WEB_PASSWORD not set — dashboard is open to anyone!')

// ── Brute force protection ────────────────────────────────────────────────────
const LOGIN_ATTEMPTS = new Map()
const MAX_LOGIN_ATTEMPTS = 5
const LOGIN_LOCK_DURATION = 15 * 60 * 1000

function getLoginState(ip) {
  if (!LOGIN_ATTEMPTS.has(ip)) LOGIN_ATTEMPTS.set(ip, { count: 0, lockUntil: 0 })
  return LOGIN_ATTEMPTS.get(ip)
}

// ── Rate limiting (120 req/min per IP) ───────────────────────────────────────
const RATE_LIMIT_WINDOW = 60 * 1000
const RATE_LIMIT_MAX = 120
const rateLimitMap = new Map()

function isLocalhost(req) {
  const ip = (req.ip || req.socket?.remoteAddress || '').replace('::ffff:', '')
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'
}

function rateLimiter(req, res, next) {
  // /api/feedback is a trusted, intentionally-bursty server-to-server endpoint: Meridian relays
  // each close twice and the backfill posts in bulk. Exempt it from localhost so those aren't
  // throttled (a 429 there silently drops real learning data). Dashboard/auth stay rate-limited.
  if (req.path === '/api/feedback' && isLocalhost(req)) return next()
  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  const now = Date.now()
  let entry = rateLimitMap.get(ip)
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) entry = { count: 1, start: now }
  else entry.count++
  rateLimitMap.set(ip, entry)
  if (entry.count > RATE_LIMIT_MAX) return res.status(429).json({ ok: false, error: 'Too many requests' })
  next()
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!AUTH_TOKEN) return next()
  // Localhost bot-to-bot: Meridian (same VPS) reads the read-only /api/meridian/* suggestion
  // + pool-signal endpoints over loopback without the dashboard token. External callers still
  // need the token. Mirrors the /api/feedback localhost exemption (Meridian → Argus push).
  if (isLocalhost(req) && (req.originalUrl || '').startsWith('/api/meridian/')) return next()
  const token = req.headers['x-auth-token'] || req.query.token
  if (token === AUTH_TOKEN) return next()
  res.status(401).json({ ok: false, error: 'Unauthorized' })
}

app.use(express.json())
app.use(rateLimiter)
app.use(express.static(path.join(__dirname, '../public')))

// Diagnostics page — served from views/ (not public/), auth on API calls only (same model as index.html)
app.get('/diagnostics', (req, res) => {
  res.sendFile(path.join(__dirname, '../views/diagnostics.html'))
})

// ── API Routes ────────────────────────────────────────────────────────────────

const { version } = require('../package.json')
const db = require('./db/database')
const { recordFeedbackOutcome } = require('./db/schema')
const { techniqueAuthor, SCREENS } = require('./intelligence/techniques')
const { getConfig } = require('./config')

// Map a Meridian close_reason to an Argus exit technique id (for live attribution).
function mapExitTechnique(closeReason) {
  if (!closeReason) return null
  const r = String(closeReason).toLowerCase()
  if (r.includes('supertrend')) return 'supertrend_break'
  if (r.includes('take') || r.includes('profit') || r.includes('tp')) return 'net_target'
  if (r.includes('stop') || r.includes('sl')) return 'il_stop'
  if (r.includes('trail')) return 'net_target'
  return null  // 'agent decision', 'oor', manual, etc. — no technique-level exit
}

// ── Auth endpoint (public — no authMiddleware) ────────────────────────────────
app.post('/api/auth', (req, res) => {
  if (!WEB_PASSWORD) return res.json({ ok: true, token: null })
  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  const state = getLoginState(ip)
  if (state.lockUntil > Date.now()) {
    const minsLeft = Math.ceil((state.lockUntil - Date.now()) / 60000)
    return res.status(429).json({ ok: false, error: `Terlalu banyak percobaan. Coba lagi dalam ${minsLeft} menit.` })
  }
  if (req.body?.password === WEB_PASSWORD) {
    LOGIN_ATTEMPTS.delete(ip)
    return res.json({ ok: true, token: AUTH_TOKEN })
  }
  state.count++
  if (state.count >= MAX_LOGIN_ATTEMPTS) {
    state.lockUntil = Date.now() + LOGIN_LOCK_DURATION
    state.count = 0
    console.warn(`[WEB] Brute force dari ${ip} — IP dikunci 15 menit`)
    return res.status(429).json({ ok: false, error: 'Terlalu banyak percobaan. IP dikunci selama 15 menit.' })
  }
  const sisa = MAX_LOGIN_ATTEMPTS - state.count
  return res.status(401).json({ ok: false, error: `Password salah (${sisa} percobaan tersisa)` })
})

// ── /api/feedback — public (server-to-server from Meridian, no auth needed) ──
app.post('/api/feedback', (req, res) => {
  try {
    const {
      source, pool_address, strategy, pnl_pct, minutes_held, close_reason,
      volatility, fee_tvl_ratio, price_change_pct, volume_change_pct,
      entry_technique, exit_technique, outcome_id, token_symbol, fees_earned_usd,
      position_type, features,
    } = req.body || {}
    const featuresJson = (features && typeof features === 'object') ? JSON.stringify(features) : null

    if (source !== 'meridian') return res.status(400).json({ error: 'source must be meridian' })
    if (!pool_address || !strategy || pnl_pct == null) {
      return res.status(400).json({ error: 'pool_address, strategy, pnl_pct required' })
    }

    // Idempotency: if this exact close was already recorded (backfill re-run / double-relay), skip
    // the learner ENTIRELY. But ENRICH it — if the existing row has no rich features yet and this
    // payload carries them, backfill the features_json (a re-backfill enriches the old thin rows
    // without re-firing pattern_library). feedback_outcomes is the marker.
    if (outcome_id) {
      const existing = db.prepare('SELECT id, features_json FROM feedback_outcomes WHERE outcome_id = ? LIMIT 1').get(outcome_id)
      if (existing) {
        const newF = (req.body?.features && typeof req.body.features === 'object') ? req.body.features : null
        if (newF) {
          // MERGE features (union) so the direct push (full set) + relay combine regardless of
          // arrival order; a re-backfill enriches old thin rows. Only write if it changes something.
          let cur = {}; try { cur = existing.features_json ? JSON.parse(existing.features_json) : {} } catch {}
          const merged = JSON.stringify({ ...cur, ...newF })
          if (merged !== (existing.features_json || '{}')) {
            db.prepare('UPDATE feedback_outcomes SET features_json = ? WHERE id = ?').run(merged, existing.id)
            return res.json({ ok: true, enriched: true })
          }
        }
        return res.json({ ok: true, deduped: true })
      }
    }

    const bus = require('./core/event-bus')
    const win = pnl_pct > 0

    // Spot LO distinction: Meridian's limit-order placement is a SOL bid below price tracked as
    // strategy='spot' + position_type='limit_order'. Mechanically it's NOT in-range spot — folding
    // it into the 'spot' learner mis-trains it. Map it to a distinct 'spot_lo' and (below) keep it
    // OUT of the (vol×regime×strategy) pattern learner — Argus tracks its live edge but doesn't gate it.
    const effectiveStrategy = (position_type === 'limit_order' && strategy === 'spot') ? 'spot_lo' : strategy

    // Phase 5 — honest live attribution: the technique that gated entry, or 'meridian_screener'
    // when Meridian entered via its screener with no indicator gate. Author from the registry.
    const entryTech = entry_technique || 'meridian_screener'
    const techAuthor = techniqueAuthor(entryTech).author
    const exitTech = exit_technique || mapExitTechnique(close_reason)
    // Record the live outcome (deduped on outcome_id) — populated after bucket is known below.
    const recordLive = (bucket, decisionId) => {
      try {
        recordFeedbackOutcome({
          created_at: new Date().toISOString(),
          outcome_id: outcome_id || null,
          source: 'meridian',
          pool_address, token_symbol: token_symbol || null, strategy: effectiveStrategy,
          entry_technique: entryTech, technique_author: techAuthor, exit_technique: exitTech || null,
          pnl_pct, fees_earned_usd: fees_earned_usd ?? null,
          win: win ? 1 : 0, minutes_held: minutes_held ?? null,
          close_reason: close_reason || null, condition_bucket: bucket || null,
          linked_decision_id: decisionId ?? null, features_json: featuresJson,
        })
      } catch (e) { console.warn('[Argus] feedback_outcome insert:', e.message) }
    }

    // Compute Argus-native condition_bucket from raw metrics
    const volBucket = computeVolBucket(volatility)
    const regime    = computeRegime(fee_tvl_ratio, price_change_pct, volume_change_pct)
    const computedBucket = (volBucket && regime) ? `${volBucket}_${regime}` : null

    // Spot LO: a Meridian-only execution variant. Record it for attribution but DON'T link it to an
    // Argus 'spot' decision and DON'T feed the pattern learner — keeps the 'spot' bucket uncontaminated.
    if (effectiveStrategy === 'spot_lo') {
      recordLive(computedBucket, null)
      console.log(`[Argus] Meridian Spot LO: ${pool_address.slice(0, 8)} pnl=${pnl_pct.toFixed(2)}% via=${entryTech} (attribution only)`)
      return res.json({ ok: true, linked: false, variant: 'spot_lo', technique: entryTech })
    }

    // Find the matching active or recently expired decision for this pool
    const decision = db.prepare(`
      SELECT id, condition_bucket FROM decisions
      WHERE pool_address = ? AND strategy = ?
        AND status IN ('active', 'expired', 'followed')
      ORDER BY created_at DESC LIMIT 1
    `).get(pool_address, strategy)

    if (!decision) {
      // No linked decision — still update Pattern Library if we have enough signal
      if (!computedBucket) {
        // Pattern Library can't use it (no bucket), but technique attribution still can.
        recordLive(null, null)
        console.log(`[Argus] Meridian feedback for ${pool_address.slice(0, 8)}: no decision/bucket — recorded for attribution only (via ${entryTech})`)
        return res.json({ ok: true, linked: false, pattern_updated: false, technique: entryTech })
      }
      recordLive(computedBucket, null)   // dedup marker first, before the pattern-learner update
      bus.emitSafe('outcome_recorded', {
        position_id:     null,
        condition_bucket: computedBucket,
        strategy,
        net_pnl_pct:     pnl_pct,
        hold_minutes:    minutes_held ?? null,
        win,
        source: 'meridian_unlinked',
      })
      console.log(`[Argus] Meridian feedback (unlinked): ${pool_address.slice(0, 8)} ${strategy} pnl=${pnl_pct.toFixed(2)}% bucket=${computedBucket} via=${entryTech}`)
      return res.json({ ok: true, linked: false, pattern_updated: true, bucket: computedBucket, win, technique: entryTech })
    }

    // Prefer the linked decision's condition_bucket, fallback to computed
    const effectiveBucket = decision.condition_bucket || computedBucket

    // Mark the decision as followed with outcome
    db.prepare(`
      UPDATE decisions
      SET status = 'followed', followed = 1, outcome_pnl_pct = ?, outcome_known = 1, win = ?
      WHERE id = ?
    `).run(pnl_pct, win ? 1 : 0, decision.id)

    recordLive(effectiveBucket, decision.id)   // dedup marker first, before the pattern-learner update
    bus.emitSafe('outcome_recorded', {
      position_id:      decision.id,
      condition_bucket: effectiveBucket,
      pool_address,
      strategy,
      net_pnl_pct:      pnl_pct,
      hold_minutes:     minutes_held ?? null,
      win,
      source: 'meridian_feedback',
    })

    console.log(`[Argus] Meridian feedback: ${pool_address.slice(0, 8)} ${strategy} pnl=${pnl_pct.toFixed(2)}% → decision #${decision.id} bucket=${effectiveBucket} win=${win} via=${entryTech}`)
    res.json({ ok: true, linked: true, decision_id: decision.id, win, bucket: effectiveBucket, technique: entryTech })
  } catch (e) {
    console.error('[Argus] Feedback error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── All /api/* routes below require auth ──────────────────────────────────────
app.use('/api', authMiddleware)

app.get('/api/scan/status', (req, res) => {
  res.json({ ok: true, last_scan: _lastScan })
})

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version,
    ts: Date.now(),
    uptime: process.uptime(),
    scheduler: scheduler.getStatus(),
    risk: riskState.state,
  })
})

app.get('/api/risk', (req, res) => res.json(riskState.state))

app.post('/api/risk/circuit-breaker/reset', (req, res) => {
  riskState.resetCircuitBreaker()
  broadcast({ type: 'risk_update', risk: riskState.state })
  const telegram = require('./notifications/telegram')
  telegram.send('✅ <b>Circuit breaker di-reset</b>\nArgus kembali aktif dan bisa membuat rekomendasi.', 'P2')
  res.json({ ok: true })
})

app.post('/api/blacklist', (req, res) => {
  const { type, value, reason } = req.body || {}
  if (!type || !value) return res.status(400).json({ error: 'type and value required' })
  if (type === 'token') riskState.blacklistToken(value, reason)
  else if (type === 'deployer') riskState.blacklistDeployer(value, reason)
  else return res.status(400).json({ error: 'type must be token or deployer' })
  broadcast({ type: 'risk_update', risk: riskState.state })
  res.json({ ok: true })
})

// Active decisions — what Argus is currently recommending
app.get('/api/candidates', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100)
    const status = req.query.status || 'active'
    const rows = db.prepare(
      `SELECT d.id, d.created_at, d.expires_at, d.token_symbol, d.token_mint, d.pool_address,
              d.strategy, d.confidence, d.condition_bucket, d.status, d.llm_verdict,
              d.indicators_json, d.strategy_scores_json, d.primary_technique, d.technique_author,
              dr.entry_price_sol, dr.range_pct, dr.range_bins, dr.sol_amount
       FROM decisions d
       LEFT JOIN dry_run_positions dr
         ON dr.decision_id = d.id AND dr.status = 'open'
       WHERE d.status = ?
       ORDER BY d.created_at DESC LIMIT ?`
    ).all(status, limit)
    // Parse JSON fields per-row — bad JSON in one row should not 500 the whole endpoint
    const parsed = rows.map(r => {
      let indicators = null, strategy_scores = null
      try { indicators = r.indicators_json ? JSON.parse(r.indicators_json) : null } catch {}
      try { strategy_scores = r.strategy_scores_json ? JSON.parse(r.strategy_scores_json) : null } catch {}
      return { ...r, indicators, strategy_scores, indicators_json: undefined, strategy_scores_json: undefined }
    })
    res.json({ decisions: parsed, count: parsed.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Manual scan trigger — useful for testing without waiting 15min
app.post('/api/scan/run', async (req, res) => {
  try {
    const ic = require('./intelligence/index')
    // Fire-and-forget — results pushed via WebSocket
    ic.runScan().catch(err => console.error('[Server] Manual scan error:', err.message))
    res.json({ ok: true, message: 'Scan triggered — watch WebSocket for results' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/dry-run', (req, res) => {
  try {
    const dryRun = require('./dry-run/engine')
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 200)
    const status = req.query.status  // optional filter: 'open' | 'closed'

    const VALID_STATUS = ['open', 'closed', 'expired']
    const safeStatus = VALID_STATUS.includes(status) ? status : null
    const where = safeStatus ? 'WHERE dr.status = ?' : ''
    const params = safeStatus ? [safeStatus, limit] : [limit]
    const positions = db.prepare(`
      SELECT dr.id, dr.opened_at, dr.closed_at, dr.token_symbol, dr.token_mint,
             dr.pool_address, dr.strategy, dr.entry_price_sol, dr.exit_price_sol,
             dr.sol_amount, dr.range_bins, dr.gross_pnl_pct, dr.net_pnl_pct,
             dr.simulated_fee_pct, dr.hold_minutes, dr.close_reason,
             dr.status, dr.outcome_valid,
             d.confidence
      FROM dry_run_positions dr
      LEFT JOIN decisions d ON d.id = dr.decision_id
      ${where}
      ORDER BY dr.opened_at DESC LIMIT ?
    `).all(...params)

    res.json({ positions, stats: dryRun.getStats() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
// Full detail for one dry-run position (sim P&L + the REAL entry conditions it screened on)
app.get('/api/dry-run/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const p = db.prepare(`SELECT * FROM dry_run_positions WHERE id = ?`).get(id)
    if (!p) return res.status(404).json({ error: 'not found' })
    let indicators = null
    if (p.decision_id) {
      const d = db.prepare(`SELECT indicators_json, condition_bucket, confidence,
                                   primary_technique, technique_author
                            FROM decisions WHERE id = ?`).get(p.decision_id)
      if (d) {
        try { indicators = d.indicators_json ? JSON.parse(d.indicators_json) : null } catch {}
        p.condition_bucket   = d.condition_bucket
        p.confidence         = d.confidence
        p.primary_technique  = p.entry_technique || d.primary_technique
        p.technique_author   = d.technique_author
      }
    }
    let exit_metrics = null
    try { exit_metrics = p.exit_metrics_json ? JSON.parse(p.exit_metrics_json) : null } catch {}
    res.json({ position: { ...p, indicators, exit_metrics, exit_metrics_json: undefined } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
app.get('/api/pattern-library', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT volatility_bucket, regime, strategy, win_rate, mean_pnl_net,
             sample_count, active, updated_at,
             source, live_sample_count, sim_sample_count, reality_gap,
             nofill_count
      FROM pattern_library
      ORDER BY sample_count DESC, active DESC
    `).all()
    res.json({ patterns: rows, total: rows.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Tier 1-C — exit-technique effectiveness rollup. Surfaces which exit (net_target / il_stop /
// max_hold / trailing_tp / price_ran_up) fires how often per strategy and how it performs.
app.get('/api/exit-techniques', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT strategy, exit_technique, sample_count, wins, win_rate, mean_pnl_net,
             avg_hold_minutes, nofill_count, share_pct, updated_at
      FROM exit_technique_stats
      ORDER BY strategy, share_pct DESC, sample_count DESC
    `).all()
    res.json({ exits: rows, total: rows.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Technique attribution (Phase 4) ────────────────────────────────────────────
// Secondary, on-demand rollup: closed dry-run outcomes grouped by the technique that
// entered (or exited) each position, joined to the registry for provenance. Used for the
// attribution dashboard — NOT for gating (the primary learner stays vol×regime×strategy).
app.get('/api/techniques/performance', (req, res) => {
  try {
    const reg = db.prepare(`SELECT id, label, author, author_type, side, kind, applies_to, maturity FROM techniques`).all()
    const agg = (col) => db.prepare(`
      SELECT ${col} AS tech, strategy,
             COUNT(*) AS n,
             SUM(CASE WHEN net_pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
             ROUND(AVG(net_pnl_pct), 3) AS mean_pnl
      FROM dry_run_positions
      WHERE status = 'closed' AND outcome_valid = 1 AND ${col} IS NOT NULL
      GROUP BY ${col}, strategy
    `).all()
    const entryRows = agg('entry_technique')
    const exitRows  = agg('exit_technique')

    const roll = (rows) => {
      const byTech = {}
      for (const r of rows) {
        const t = (byTech[r.tech] ||= { n: 0, wins: 0, pnlSum: 0, by_strategy: [] })
        t.n += r.n; t.wins += r.wins; t.pnlSum += (r.mean_pnl || 0) * r.n
        t.by_strategy.push({ strategy: r.strategy, n: r.n, wins: r.wins,
          win_rate: r.n ? Math.round(r.wins / r.n * 100) / 100 : null, mean_pnl_net: r.mean_pnl })
      }
      for (const t of Object.values(byTech)) {
        t.win_rate = t.n ? Math.round(t.wins / t.n * 100) / 100 : null
        t.mean_pnl_net = t.n ? Math.round(t.pnlSum / t.n * 1000) / 1000 : null
        delete t.pnlSum
      }
      return byTech
    }
    const entryByTech = roll(entryRows)
    const exitByTech  = roll(exitRows)

    // LIVE source (Phase 5): real Meridian outcomes grouped by entry technique.
    const liveRows = db.prepare(`
      SELECT entry_technique AS tech, strategy,
             COUNT(*) AS n,
             SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
             ROUND(AVG(pnl_pct), 3) AS mean_pnl
      FROM feedback_outcomes
      WHERE entry_technique IS NOT NULL
      GROUP BY entry_technique, strategy
    `).all()
    const liveByTech = roll(liveRows)

    // TIMING techniques only (kind!='screen') — entry/exit outcome rollup. Screens are handled
    // separately (counterfactual) so they never pollute the timing attribution.
    // reality_gap = live win-rate − dry-run win-rate: how wrong the simulation is for this technique.
    const techniques = reg.filter(t => t.kind !== 'screen').map(t => {
      let applies_to = []
      try { applies_to = t.applies_to ? JSON.parse(t.applies_to) : [] } catch {}
      const entry = entryByTech[t.id] || null
      const live  = liveByTech[t.id]  || null
      const reality_gap = (entry?.win_rate != null && live?.win_rate != null)
        ? Math.round((live.win_rate - entry.win_rate) * 100) / 100 : null
      return {
        id: t.id, label: t.label, author: t.author, author_type: t.author_type,
        side: t.side, maturity: t.maturity, applies_to,
        entry, live, exit: exitByTech[t.id] || null, reality_gap,
      }
    })

    // SCREENING techniques (kind='screen') — counterfactual edge over live outcomes with features.
    // A screen can't be measured by outcomes-of-passed (rejected ones have no outcome), so replay
    // its rule on history: kept vs rejected win-rate/mean + catastrophes (≤−5%) it would remove.
    const fbFeat = db.prepare(`SELECT pnl_pct, features_json FROM feedback_outcomes WHERE features_json IS NOT NULL`).all()
      .map(r => { try { return { pnl: r.pnl_pct, f: JSON.parse(r.features_json) } } catch { return null } }).filter(Boolean)
    const antirugCfg = getConfig().screening?.antirug || {}
    const wr = a => a.length ? Math.round(a.filter(x => x.pnl > 0).length / a.length * 100) / 100 : null
    const mn = a => a.length ? Math.round(a.reduce((s, x) => s + x.pnl, 0) / a.length * 1000) / 1000 : null
    const baseMean = mn(fbFeat)
    const screens = reg.filter(t => t.kind === 'screen').map(t => {
      let applies_to = []; try { applies_to = t.applies_to ? JSON.parse(t.applies_to) : [] } catch {}
      const ev = SCREENS[t.id]?.test
      const base = { id: t.id, label: t.label, author: t.author, author_type: t.author_type,
        maturity: t.maturity, applies_to, kind: 'screen' }
      if (!ev) return { ...base, evaluator: false }
      const kept = [], rej = [], unknown = []
      for (const x of fbFeat) { const v = ev(x.f, antirugCfg); (v === true ? kept : v === false ? rej : unknown).push(x) }
      return {
        ...base, evaluated: fbFeat.length, kept: kept.length, rejected: rej.length, unknown: unknown.length,
        kept_wr: wr(kept), kept_mean: mn(kept), rejected_wr: wr(rej), rejected_mean: mn(rej),
        catastrophes_total: fbFeat.filter(x => x.pnl <= -5).length,
        catastrophes_rejected: rej.filter(x => x.pnl <= -5).length,
        lift: (mn(kept) != null && baseMean != null) ? Math.round((mn(kept) - baseMean) * 1000) / 1000 : null,
      }
    })

    // Per-author rollup: dry-run AND live edge side by side ("whose technique wins, for real").
    const authorMap = {}
    const acc = (src, key) => {
      for (const t of reg) {
        const p = src[t.id]; if (!p) continue
        const a = (authorMap[t.author] ||= { author: t.author, author_type: t.author_type,
          dry: { n: 0, wins: 0, pnlSum: 0 }, live: { n: 0, wins: 0, pnlSum: 0 } })
        a[key].n += p.n; a[key].wins += p.wins; a[key].pnlSum += (p.mean_pnl_net || 0) * p.n
      }
    }
    acc(entryByTech, 'dry'); acc(liveByTech, 'live')
    const fin = (g) => ({ sample_count: g.n, wins: g.wins,
      win_rate: g.n ? Math.round(g.wins / g.n * 100) / 100 : null,
      mean_pnl_net: g.n ? Math.round(g.pnlSum / g.n * 1000) / 1000 : null })
    const by_author = Object.values(authorMap).map(a => ({
      author: a.author, author_type: a.author_type, dry: fin(a.dry), live: fin(a.live),
    })).sort((x, y) => (y.live.win_rate ?? y.dry.win_rate ?? -1) - (x.live.win_rate ?? x.dry.win_rate ?? -1))

    // Shadow A/B: for limit_order bb_plus_rsi entries, how often did the shadow agree?
    const shadowRows = db.prepare(`
      SELECT signal_provenance_json FROM decisions
      WHERE strategy = 'limit_order' AND signal_provenance_json IS NOT NULL
      ORDER BY id DESC LIMIT 500
    `).all()
    let agree = 0, disagree = 0, primary = 'bb_plus_rsi', shadowTech = 'supertrend_or_rsi'
    for (const r of shadowRows) {
      try {
        const p = JSON.parse(r.signal_provenance_json)
        const primaryConfirmed = (p.confirmations || []).some(c => c.confirmed)
        if (!primaryConfirmed || !p.shadow) continue
        if (p.shadow.skipped) continue
        if (p.shadow.confirmed) agree++; else disagree++
        if (p.primary_technique) primary = p.primary_technique
        if (p.shadow.technique) shadowTech = p.shadow.technique
      } catch {}
    }
    const shadow_ab = { primary, shadow: shadowTech, agree, disagree,
      total: agree + disagree, agreement_rate: (agree + disagree) ? Math.round(agree / (agree + disagree) * 100) / 100 : null }

    res.json({ techniques, screens, by_author, shadow_ab })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Meridian Integration API ──────────────────────────────────────────────────

app.get('/api/meridian/recommendations', (req, res) => {
  try {
    const meridian = require('./meridian/index')
    res.json({ recommendations: meridian.getActiveRecommendations() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/meridian/pool/:address/signal', (req, res) => {
  try {
    const meridian = require('./meridian/index')
    res.json(meridian.getPoolSignal(req.params.address))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/meridian/smart-wallets', (req, res) => {
  try {
    const meridian = require('./meridian/index')
    res.json(meridian.getSmartWalletsForMeridian())
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/meridian/webhook/test', async (req, res) => {
  try {
    const meridian = require('./meridian/index')
    await meridian.pushRecommendation({ token_symbol: 'TEST', strategy: 'spot', confidence: 1.0, test: true })
    res.json({ ok: true, message: 'Test payload sent to meridian.webhookUrl' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ── Meridian Feedback API ─────────────────────────────────────────────────────
// Meridian pushes real trade outcomes here so Argus Pattern Library learns from
// actual execution results, not just dry-run simulations.

// Compute Argus volatility bucket from raw vol value (mirrors IC screener logic)
function computeVolBucket(vol) {
  if (vol == null || !Number.isFinite(vol)) return null
  if (vol > 2) return 'high'
  if (vol > 1) return 'medium'
  return 'low'
}

// Compute Argus regime from pool metrics (mirrors IC screener logic)
function computeRegime(feeTvl, pricePct, volPct) {
  if (Number.isFinite(pricePct) && Number.isFinite(volPct) && pricePct > 5 && volPct > 30) return 'recovery'
  if (Number.isFinite(pricePct) && pricePct < -5) return 'decline'
  if (Number.isFinite(feeTvl) && feeTvl > 0.3) return 'froth'
  return 'neutral'
}

// ── Hivemind Discovery API ────────────────────────────────────────────────────

app.get('/api/hivemind', (req, res) => {
  try {
    const hivemind = require('./wallet/hivemind-discovery')
    res.json(hivemind.getStatus())
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/hivemind/wallets', (req, res) => {
  try {
    const hivemind = require('./wallet/hivemind-discovery')
    res.json({ wallets: hivemind.getTrackedWallets() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/hivemind/run', async (req, res) => {
  try {
    const hivemind = require('./wallet/hivemind-discovery')
    hivemind.runDiscovery().catch(e => console.error('[Hivemind] Manual run error:', e.message))
    res.json({ ok: true, message: 'Discovery started — check logs for progress' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/hivemind/source/:name/pause', (req, res) => {
  try {
    const hivemind = require('./wallet/hivemind-discovery')
    const durationMs = parseInt(req.body?.durationMs, 10) || (24 * 3600 * 1000)
    hivemind.pauseSource(req.params.name, durationMs)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/hivemind/source/:name/resume', (req, res) => {
  try {
    const hivemind = require('./wallet/hivemind-discovery')
    hivemind.resumeSource(req.params.name)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/wallet-actions', (req, res) => {
  try {
    const wallet = require('./wallet/index')
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 200)
    const actions = db.prepare(`
      SELECT id, detected_at, action_type, pool_address, token_mint, token_symbol,
             strategy, amount_sol, matched_decision_id, match_category,
             wallet_address, wallet_label, wallet_type
      FROM wallet_actions
      ORDER BY detected_at DESC LIMIT ?
    `).all(limit)
    // Enrich from the rich Meridian outcomes (feedback_outcomes) by pool — own actions
    // ARE Meridian's trades, so fill the missing token + surface the real P&L per pool.
    const pools = [...new Set(actions.map(a => a.pool_address).filter(Boolean))]
    const foByPool = {}
    if (pools.length) {
      const ph = pools.map(() => '?').join(',')
      for (const f of db.prepare(`
        SELECT pool_address, token_symbol, pnl_pct, win
        FROM feedback_outcomes WHERE pool_address IN (${ph})
        ORDER BY created_at DESC
      `).all(...pools)) {
        if (!foByPool[f.pool_address]) foByPool[f.pool_address] = f  // latest per pool
      }
    }
    const enriched = actions.map(a => {
      const fo = foByPool[a.pool_address]
      return {
        ...a,
        token_symbol:    a.token_symbol || fo?.token_symbol || null,
        outcome_pnl_pct: fo?.pnl_pct ?? null,
        outcome_win:     fo?.win ?? null,
      }
    })
    res.json({ actions: enriched, status: wallet.observer.getStatus() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/screening-rejections', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 500)
    const since = req.query.since  // optional ISO timestamp filter
    const rows = since
      ? db.prepare(`SELECT * FROM screening_rejections WHERE scanned_at >= ? ORDER BY scanned_at DESC LIMIT ?`).all(since, limit)
      : db.prepare(`SELECT * FROM screening_rejections ORDER BY scanned_at DESC LIMIT ?`).all(limit)
    // Top reject reasons summary
    const summary = db.prepare(`
      SELECT reason, reject_stage, COUNT(*) AS count
      FROM screening_rejections
      GROUP BY reason, reject_stage
      ORDER BY count DESC
      LIMIT 20
    `).all()
    res.json({ rejections: rows, summary })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Screening funnel: per-pipeline waterfall showing how many pools were eliminated at each stage.
// Query window: last 24h of rejections (covers several scan cycles).
// "passed" is derived from decisions created in the same window per strategy.
app.get('/api/screening-funnel', (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours || '24', 10), 168)
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()

    // Rejections per pipeline × stage × reason (last N hours)
    const rejRows = db.prepare(`
      SELECT
        COALESCE(pipeline, 'unknown') AS pipeline,
        reject_stage,
        reason,
        COUNT(*) AS count
      FROM screening_rejections
      WHERE scanned_at >= ?
      GROUP BY pipeline, reject_stage, reason
      ORDER BY pipeline, reject_stage, count DESC
    `).all(since)

    // Decisions per strategy in same window (proxy for "passed")
    const passedRows = db.prepare(`
      SELECT strategy, COUNT(*) AS count
      FROM decisions
      WHERE created_at >= ?
      GROUP BY strategy
    `).all(since)

    const passedMap = {}
    for (const r of passedRows) passedMap[r.strategy] = r.count

    // Build per-pipeline funnel
    const funnels = {}
    for (const r of rejRows) {
      if (!funnels[r.pipeline]) funnels[r.pipeline] = { stages: {} }
      const s = funnels[r.pipeline].stages
      if (!s[r.reject_stage]) s[r.reject_stage] = { total: 0, reasons: [] }
      s[r.reject_stage].total += r.count
      s[r.reject_stage].reasons.push({ reason: r.reason, count: r.count })
    }

    // Attach passed counts (pipeline name == strategy name in our setup)
    for (const [pipe, data] of Object.entries(funnels)) {
      data.passed = passedMap[pipe] ?? 0
    }

    // Also include pipelines that had decisions but no rejections (rare — all passed)
    for (const [strategy, count] of Object.entries(passedMap)) {
      if (!funnels[strategy]) funnels[strategy] = { stages: {}, passed: count }
    }

    res.json({ window_hours: hours, since, pipelines: funnels })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Effective config: shows the resolved screening config for each pipeline (after profile merging).
// Read-only — no mutation. Useful for diagnosing why a pool was rejected.
app.get('/api/config/effective', (req, res) => {
  try {
    const { getConfig } = require('./config')
    const { resolveScreening } = require('./intelligence/index')
    const cfg = getConfig()
    const pipelines = cfg.scan?.pipelines ?? [
      { profile: 'bid_ask',     strategy: 'bid_ask' },
      { profile: 'spot',        strategy: 'spot' },
      { profile: 'limit_order', strategy: 'limit_order' },
    ]
    const effective = {}
    for (const pipe of pipelines) {
      effective[pipe.profile] = resolveScreening(cfg, pipe.profile)
    }
    res.json({ pipelines: effective })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/capability-gaps', (req, res) => {
  try {
    const status = req.query.status || 'open'
    const rows = status === 'all'
      ? db.prepare(`SELECT * FROM capability_gaps ORDER BY last_seen_at DESC LIMIT 200`).all()
      : db.prepare(`SELECT * FROM capability_gaps WHERE status = ? ORDER BY
          CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen_at DESC`).all(status)
    res.json({ gaps: rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/self-report', async (req, res) => {
  try {
    if (req.query.fresh === '1') {
      const r = await require('./ai/system-report').generateSystemReport()
      return res.json({ via: r?.via, text: r?.text, fresh: true })
    }
    const row = db.prepare(`SELECT * FROM system_reports ORDER BY generated_at DESC LIMIT 1`).get()
    res.json({ report: row || null })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/tuning-events', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200)
    res.json({ events: require('./db/schema').getTuningEvents(limit) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/tuning-events/:id/approve', express.json(), (req, res) => {
  try {
    const r = require('./learning/auto-tuner').approveProposal(parseInt(req.params.id, 10))
    res.status(r.ok ? 200 : 400).json(r)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/tuning-events/:id/reject', express.json(), (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    const n = db.prepare(`UPDATE tuning_events SET status='rejected' WHERE id=? AND status='proposed'`).run(id)
    res.json({ ok: n.changes > 0 })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Meridian Feedback History ─────────────────────────────────────────────────
// Show decisions that Meridian actually followed + outcomes received
app.get('/api/feedback/history', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '40', 10), 200)
    // Source: feedback_outcomes — the LIVE ground-truth of every real Meridian close
    // (deduped on outcome_id). Previously this read `decisions WHERE outcome_known=1`,
    // which only surfaced outcomes that linked to an independent Argus decision and so
    // hid most real Meridian executions + carried no technique attribution.
    const rows = db.prepare(`
      SELECT id, created_at, token_symbol, pool_address,
             strategy, condition_bucket,
             pnl_pct AS outcome_pnl_pct, win,
             entry_technique, technique_author, exit_technique,
             close_reason, minutes_held
      FROM feedback_outcomes
      ORDER BY created_at DESC LIMIT ?
    `).all(limit)
    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN win = 1 THEN 1 ELSE 0 END) AS wins,
             AVG(pnl_pct) AS avg_pnl,
             SUM(pnl_pct) AS total_pnl
      FROM feedback_outcomes
    `).get()
    res.json({ outcomes: rows, stats })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── WebSocket ─────────────────────────────────────────────────────────────────

let wss
let _wsWired = false
const clients = new Set()
let _lastScan = null

function broadcast(payload) {
  const msg = JSON.stringify(payload)
  for (const ws of clients) {
    try {
      if (ws.readyState === 1) ws.send(msg)
    } catch { clients.delete(ws) }
  }
}

function setupWebSocket(server) {
  wss = new WebSocketServer({ server })

  wss.on('connection', (ws, req) => {
    if (AUTH_TOKEN) {
      const url = new URL(req.url, 'http://localhost')
      const token = url.searchParams.get('token')
      if (token !== AUTH_TOKEN) { ws.close(4401, 'Unauthorized'); return }
    }
    clients.add(ws)
    // Send current state on connect
    ws.send(JSON.stringify({ type: 'init', risk: riskState.state, ts: Date.now() }))

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw)
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }))
      } catch {}
    })

    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  // Forward bus events to all connected UI clients — guard against double-registration
  if (!_wsWired) {
    _wsWired = true
    bus.onFast('ui_update', (payload) => {
      if (payload?.type === 'scan_result') _lastScan = payload
      broadcast(payload)
    })
    bus.onFast('risk_gate_blocked', (payload) => broadcast({ type: 'risk_gate_blocked', ...payload }))
    bus.onFast('recommendation_expired', (payload) => broadcast({ type: 'recommendation_expired', ...payload }))
    bus.onFast('scan_complete', (payload) => broadcast({ type: 'scan_complete', ...payload }))
    bus.onFast('alert_triggered', (payload) => broadcast({ type: 'alert_triggered', ...payload }))
    bus.onSlow('wallet_action_detected', (payload) => broadcast({ type: 'wallet_action_detected', ...payload }))
    bus.onSlow('tracked_wallets_updated', (payload) => broadcast({ type: 'tracked_wallets_updated', ...payload }))
    bus.onSlow('capability_gap_detected', (payload) => broadcast({ type: 'capability_gap_detected', ...payload }))
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let httpServer

async function start() {
  httpServer = http.createServer(app)
  setupWebSocket(httpServer)
  await new Promise((resolve) => httpServer.listen(PORT, HOST, resolve))
}

async function stop() {
  return new Promise((resolve) => httpServer?.close(resolve))
}

module.exports = { app, start, stop, broadcast }
