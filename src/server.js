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

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '0.1.0',
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

// Placeholders for future phases
app.get('/api/candidates', (req, res) => res.json({ candidates: [], phase: 1 }))
app.get('/api/dry-run', (req, res) => res.json({ positions: [], phase: 2 }))
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
