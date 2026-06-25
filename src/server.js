'use strict'
const express = require('express')
const { WebSocketServer } = require('ws')
const http = require('http')
const path = require('path')
const bus = require('./core/event-bus')
const riskState = require('./core/risk-state')
const scheduler = require('./core/scheduler')

const app = express()
const PORT = parseInt(process.env.PORT || '4000')
const HOST = process.env.HOST || '127.0.0.1'

app.use(express.json())
app.use(express.static(path.join(__dirname, '../public')))

// ── API Routes ────────────────────────────────────────────────────────────────

const { version } = require('../package.json')
const db = require('./db/database')

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
      `SELECT id, created_at, expires_at, token_symbol, token_mint, pool_address,
              strategy, confidence, condition_bucket, status, llm_verdict,
              indicators_json, strategy_scores_json
       FROM decisions WHERE status = ?
       ORDER BY created_at DESC LIMIT ?`
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
             dr.sol_amount, dr.gross_pnl_pct, dr.net_pnl_pct, dr.hold_minutes,
             dr.status, dr.outcome_valid
      FROM dry_run_positions dr
      ${where}
      ORDER BY dr.opened_at DESC LIMIT ?
    `).all(...params)

    res.json({ positions, stats: dryRun.getStats() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
app.get('/api/pattern-library', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT volatility_bucket, regime, strategy, win_rate, mean_pnl_net,
             sample_count, active, updated_at
      FROM pattern_library
      ORDER BY sample_count DESC, active DESC
    `).all()
    res.json({ patterns: rows, total: rows.length })
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

app.post('/api/feedback', (req, res) => {
  try {
    const { source, pool_address, strategy, pnl_pct, minutes_held, close_reason, volatility, fee_tvl_ratio } = req.body || {}

    if (source !== 'meridian') return res.status(400).json({ error: 'source must be meridian' })
    if (!pool_address || !strategy || pnl_pct == null) {
      return res.status(400).json({ error: 'pool_address, strategy, pnl_pct required' })
    }

    // Find the matching active or recently expired decision for this pool
    const decision = db.prepare(`
      SELECT id, condition_bucket FROM decisions
      WHERE pool_address = ? AND strategy = ?
        AND status IN ('active', 'expired', 'followed')
      ORDER BY created_at DESC LIMIT 1
    `).get(pool_address, strategy)

    if (!decision) {
      console.log(`[Argus] Feedback received from Meridian for ${pool_address.slice(0, 8)} but no matching decision found — storing as unlinked outcome`)
      return res.json({ ok: true, linked: false })
    }

    // Mark the decision as followed with outcome
    const win = pnl_pct > 0
    db.prepare(`
      UPDATE decisions
      SET status = 'followed', followed = 1, outcome_pnl_pct = ?, outcome_known = 1, win = ?
      WHERE id = ?
    `).run(pnl_pct, win ? 1 : 0, decision.id)

    // Feed into Pattern Library via the learning bus
    const bus = require('./core/event-bus')
    bus.emitSafe('outcome_recorded', {
      position_id:  decision.id,
      pool_address,
      strategy,
      net_pnl_pct:  pnl_pct,
      hold_minutes: minutes_held ?? null,
      win,
      source: 'meridian_feedback',
    })

    console.log(`[Argus] Meridian feedback recorded: ${pool_address.slice(0, 8)} ${strategy} pnl=${pnl_pct.toFixed(2)}% → decision #${decision.id} (win=${win})`)
    res.json({ ok: true, linked: true, decision_id: decision.id, win })
  } catch (e) {
    console.error('[Argus] Feedback error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

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
    res.json({ actions, status: wallet.observer.getStatus() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── WebSocket ─────────────────────────────────────────────────────────────────

let wss
let _wsWired = false
const clients = new Set()

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

  wss.on('connection', (ws) => {
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
    bus.onFast('ui_update', (payload) => broadcast(payload))
    bus.onFast('risk_gate_blocked', (payload) => broadcast({ type: 'risk_gate_blocked', ...payload }))
    bus.onFast('recommendation_expired', (payload) => broadcast({ type: 'recommendation_expired', ...payload }))
    bus.onFast('scan_complete', (payload) => broadcast({ type: 'scan_complete', ...payload }))
    bus.onFast('alert_triggered', (payload) => broadcast({ type: 'alert_triggered', ...payload }))
    bus.onSlow('wallet_action_detected', (payload) => broadcast({ type: 'wallet_action_detected', ...payload }))
    bus.onSlow('tracked_wallets_updated', (payload) => broadcast({ type: 'tracked_wallets_updated', ...payload }))
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
