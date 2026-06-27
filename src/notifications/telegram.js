'use strict'
const fetch = require('node-fetch')

const BASE_URL = 'https://api.telegram.org/bot'

// Priority levels — determines channel and retry behavior
// P1: Critical (dump, circuit breaker) → always send + retry 5x
// P2: Important (new recommendation, fill) → send + retry 3x
// P3: Info (scan complete, boot) → send, no retry
// P4: Debug/verbose → log only unless DEBUG_TELEGRAM=1

const PRIORITY_PREFIX = { P1: '🔴 ', P2: '🟡 ', P3: '🔵 ', P4: '' }
const PRIORITY_RETRIES = { P1: 5, P2: 3, P3: 0, P4: 0 }

class TelegramNotifier {
  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN || ''
    this.chatId = process.env.TELEGRAM_CHAT_ID || ''
    this.enabled = false
    this._retryQueue = []
    this._retryRunning = false
  }

  async init() {
    if (!this.token || !this.chatId) {
      console.log('[Telegram] Disabled — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env')
      return
    }
    try {
      const res = await this._api('getMe')
      this.enabled = true
      console.log(`✓  Telegram connected as @${res.result.username}`)
    } catch (err) {
      console.warn('[Telegram] Could not connect:', err.message, '— running without Telegram')
    }
  }

  async _api(method, body = {}) {
    const res = await fetch(`${BASE_URL}${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 8000,
    })
    const data = await res.json()
    if (!data.ok) throw new Error(data.description || `Telegram ${method} error`)
    return data
  }

  // Send a message. Returns message_id or null.
  async send(text, priority = 'P2') {
    if (!this.enabled) {
      if (priority !== 'P4' || process.env.DEBUG_TELEGRAM === '1') {
        console.log(`[Telegram-${priority}]`, text.replace(/<[^>]+>/g, ''))
      }
      return null
    }

    const message = (PRIORITY_PREFIX[priority] || '') + text
    const maxRetries = PRIORITY_RETRIES[priority] || 0

    try {
      const res = await this._api('sendMessage', {
        chat_id: this.chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      })
      return res.result.message_id
    } catch (err) {
      console.warn(`[Telegram] Send failed (${priority}):`, err.message)
      if (maxRetries > 0) {
        this._retryQueue.push({ text: message, attemptsLeft: maxRetries })
        this._drainRetryQueue().catch(e => console.warn('[Telegram] Retry drain error:', e.message))
      }
      return null
    }
  }

  // Edit an existing message (for live updates)
  async edit(messageId, text) {
    if (!this.enabled || !messageId) return
    try {
      await this._api('editMessageText', {
        chat_id: this.chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      })
    } catch {}
  }

  async _drainRetryQueue() {
    if (this._retryRunning || this._retryQueue.length === 0) return
    this._retryRunning = true
    while (this._retryQueue.length > 0) {
      const item = this._retryQueue[0]
      if (item.attemptsLeft <= 0) { this._retryQueue.shift(); continue }
      const delay = Math.min(2000 * (PRIORITY_RETRIES.P1 - item.attemptsLeft + 1), 30000)
      await new Promise(r => setTimeout(r, delay))
      try {
        await this._api('sendMessage', { chat_id: this.chatId, text: item.text, parse_mode: 'HTML' })
        this._retryQueue.shift()
      } catch {
        item.attemptsLeft--
        if (item.attemptsLeft <= 0) this._retryQueue.shift()
      }
    }
    this._retryRunning = false
  }

  // ── Named Templates ────────────────────────────────────────────────────────

  recommendation({ token, strategy, confidence, ttlMinutes, verdict, poolUrl, entryPrice, rangePct, rangeLow }) {
    const stratLabel = { limit_order: 'Limit Order', spot: 'Spot LP', bid_ask: 'Bid Ask' }[strategy] || strategy
    const serverUrl  = process.env.ARGUS_SERVER_URL || `http://localhost:${process.env.PORT || 4000}`
    const verdictLine = verdict ? `\n"${verdict}"` : ''
    const fmtSol = (x) => x == null ? '?' : (x >= 1 ? x.toFixed(4) : x >= 0.0001 ? x.toFixed(8) : Number(x).toPrecision(4))
    // Entry parameters for manual execution: single-sided SOL bid BELOW price.
    const entryLine = (entryPrice != null && rangePct != null)
      ? `\n📍 entry ${fmtSol(entryPrice)} SOL · bid ↓ −${(rangePct * 100).toFixed(1)}%` +
        (rangeLow != null ? ` → ${fmtSol(rangeLow)}` : '')
      : ''
    return this.send(
      `🎯 <b>${token}</b> · ${stratLabel} · ${confidence}% conf · valid ${ttlMinutes}m` +
      entryLine + verdictLine + '\n' +
      // No external pool/token link — opsec: a click would leak the viewer's IP to the
      // destination's analytics. Only the self-hosted dashboard link remains.
      `<a href="${serverUrl}">Dashboard</a>`,
      'P2'
    )
  }

  circuitBreaker(reason) {
    return this.send(
      `⚠️ <b>CIRCUIT BREAKER TERBUKA</b>\n${reason}\n\n` +
      `Reset manual diperlukan di dashboard Argus.`,
      'P1'
    )
  }

  dumpAlert(token, dropPct, poolAddress) {
    return this.send(
      `🚨 <b>DUMP TERDETEKSI</b> — ${token}\n` +
      `Drop: <b>${dropPct.toFixed(1)}%</b>\n` +
      `Pool: <code>${poolAddress?.slice(0, 12)}…</code>`,
      'P1'
    )
  }

  dryRunResult({ token, strategy, netPnlPct, holdMinutes }) {
    const emoji = netPnlPct >= 0 ? '✅' : '❌'
    return this.send(
      `${emoji} <b>Dry Run Selesai</b> — ${token}\n` +
      `Strategy: ${strategy} · ${netPnlPct >= 0 ? '+' : ''}${netPnlPct.toFixed(2)}% net · ${holdMinutes}m`,
      'P3'
    )
  }

  // Immediate alert for a HIGH-severity capability gap (structural blind spot). Lower-severity
  // gaps ride the daily system report instead (consolidated digest).
  capabilityAlert({ kind, strategy, reason_key, saturation_pct, suggested_action }) {
    return this.send(
      `🧩 <b>Capability Gap</b> — ${kind}${strategy ? ` (${strategy})` : ''}\n` +
      `${reason_key} saturated ${saturation_pct}%\n${suggested_action || ''}`,
      'P2'
    )
  }

  // Consolidated daily status digest (Phase 5). Narration of pre-computed stats only.
  systemReport(text) {
    return this.send(
      `${text}\n\n<i>Status narration of pre-computed statistics. Does not place trades, change config, or constitute a recommendation.</i>`,
      'P3'
    )
  }

  // Auto-tuner shadow proposal (Phase 4B). Informational; APPLY requires explicit approval.
  tuningProposal({ param_path, old_value, new_value, reason }) {
    return this.send(
      `🎛️ <b>Tuner proposal (shadow)</b>\n${param_path}: ${old_value} → ${new_value}\n${reason || ''}`,
      'P2'
    )
  }

  boot(port) {
    const serverUrl = process.env.ARGUS_SERVER_URL || `http://localhost:${port}`
    return this.send(
      `<b>Argus online</b>\n<a href="${serverUrl}">Dashboard</a>`,
      'P3'
    )
  }

  // ── Polling / Command Handling ─────────────────────────────────────────────

  startPolling() {
    if (!this.enabled) return
    this._offset = 0
    console.log('[Telegram] Command polling started')
    this._poll()
  }

  async _poll() {
    try {
      const res = await this._api('getUpdates', {
        offset: this._offset,
        timeout: 5,
        allowed_updates: ['message'],
      })
      for (const update of res.result || []) {
        this._offset = update.update_id + 1
        const text = update.message?.text || ''
        const chatId = update.message?.chat?.id
        if (!chatId || !text.startsWith('/')) continue
        const fromId = String(update.message?.from?.id || '')
        const allowedChatId = String(this.chatId)
        if (fromId !== allowedChatId && String(chatId) !== allowedChatId) continue
        await this._handleCommand(text.split(' ')[0].toLowerCase(), chatId)
      }
    } catch (e) {
      console.warn('[Telegram] Poll error:', e.message)
    }
    setTimeout(() => this._poll(), 1000)
  }

  async _handleCommand(cmd, chatId) {
    const send = (text) => this._api('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
    })

    if (cmd === '/start' || cmd === '/help') {
      return send(
        '<b>Argus — DLMM Intelligence Bot</b>\n\n' +
        '/status — status sistem &amp; dry run stats\n' +
        '/scan — trigger scan kandidat sekarang\n' +
        '/reset — reset circuit breaker\n' +
        '/help — tampilkan pesan ini'
      )
    }

    if (cmd === '/status') {
      try {
        const riskState = require('../core/risk-state')
        const scheduler = require('../core/scheduler')
        const db = require('../db/database')
        const r = riskState.state
        const jobs = scheduler.getStatus()
        const stats = db.prepare(`
          SELECT
            SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END) AS closed,
            ROUND(AVG(CASE WHEN status='closed' AND net_pnl_pct IS NOT NULL THEN net_pnl_pct END), 2) AS avg_pnl,
            ROUND(100.0 * SUM(CASE WHEN status='closed' AND net_pnl_pct > 0 THEN 1 ELSE 0 END) /
              NULLIF(SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END), 0), 0) AS win_rate
          FROM dry_run_positions
        `).get() || {}
        const cb = r.circuit_breaker_open ? '🔴 OPEN' : '🟢 clear'
        return send(
          `<b>Argus Status</b>\n\n` +
          `Circuit Breaker: ${cb}\n` +
          `Posisi terbuka: ${r.current_open_count}/${r.limits?.max_open_positions || 5}\n` +
          `Daily loss: $${(r.daily_realized_loss_usd || 0).toFixed(2)}\n` +
          `Scheduler: ${jobs.length} jobs\n\n` +
          `<b>Dry Run</b>\n` +
          `Open: ${stats.open ?? 0} · Closed: ${stats.closed ?? 0}\n` +
          `Win rate: ${stats.win_rate ?? '—'}% · Avg P&amp;L: ${stats.avg_pnl ?? '—'}%`
        )
      } catch (e) {
        return send(`Error: ${e.message}`)
      }
    }

    if (cmd === '/scan') {
      try {
        const ic = require('../intelligence/index')
        ic.runScan().catch(() => {})
        return send('🔍 Scan dimulai — hasil akan dikirim via notifikasi.')
      } catch (e) {
        return send(`Error: ${e.message}`)
      }
    }

    if (cmd === '/reset') {
      try {
        const riskState = require('../core/risk-state')
        riskState.resetCircuitBreaker()
        return send('✅ Circuit breaker di-reset. Argus kembali aktif.')
      } catch (e) {
        return send(`Error: ${e.message}`)
      }
    }
  }
}

module.exports = new TelegramNotifier()
