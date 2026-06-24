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
    // Parse JSON fields for convenience
    const parsed = rows.map(r => ({
      ...r,
      indicators: r.indicators_json ? JSON.parse(r.indicators_json) : null,
      strategy_scores: r.strategy_scores_json ? JSON.parse(r.strategy_scores_json) : null,
      indicators_json: undefined,
      strategy_scores_json: undefined,
    }))
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

    const where = status ? `WHERE dr.status = '${status.replace(/'/g, "''")}'` : ''
    const positions = db.prepare(`
      SELECT dr.id, dr.opened_at, dr.closed_at, dr.token_symbol, dr.token_mint,
             dr.pool_address, dr.strategy, dr.entry_price_sol, dr.exit_price_sol,
             dr.sol_amount, dr.gross_pnl_pct, dr.net_pnl_pct, dr.hold_minutes,
             dr.status, dr.outcome_valid
      FROM dry_run_positions dr
      ${where}
      ORDER BY dr.opened_at DESC LIMIT ?
    `).all(limit)

    res.json({ positions, stats: dryRun.getStats() })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})
app.get('/api/pattern-library', (req, res) => res.json({ patterns: [], phase: 2 }))
app.get('/api/wallet-actions', (req, res) => res.json({ actions: [], phase: 3 }))

// ── WebSocket ─────────────────────────────────────────────────────────────────

let wss
const clients = new Set()

function broadcast(payload) {
  const msg = JSON.stringify(payload)
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg)
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

  // Forward bus events to all connected UI clients
  bus.onFast('ui_update', (payload) => broadcast(payload))
  bus.onFast('risk_gate_blocked', (payload) => broadcast({ type: 'risk_gate_blocked', ...payload }))
  bus.onFast('recommendation_expired', (payload) => broadcast({ type: 'recommendation_expired', ...payload }))
  bus.onFast('scan_complete', (payload) => broadcast({ type: 'scan_complete', ...payload }))
  bus.onFast('alert_triggered', (payload) => broadcast({ type: 'alert_triggered', ...payload }))
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let httpServer

async function start() {
  httpServer = http.createServer(app)
  setupWebSocket(httpServer)
  await new Promise((resolve) => httpServer.listen(PORT, '127.0.0.1', resolve))
}

async function stop() {
  return new Promise((resolve) => httpServer?.close(resolve))
}

module.exports = { app, start, stop, broadcast }
