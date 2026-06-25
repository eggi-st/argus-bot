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
        this._drainRetryQueue()
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

  recommendation({ token, strategy, confidence, ttlMinutes, verdict, poolUrl }) {
    const stratLabel = { limit_order: 'Limit Order', spot: 'Spot LP', bid_ask: 'Bid Ask' }[strategy] || strategy
    const serverUrl  = process.env.ARGUS_SERVER_URL || `http://localhost:${process.env.PORT || 4000}`
    const verdictLine = verdict ? `\n"${verdict}"` : ''
    return this.send(
      `🎯 <b>${token}</b> · ${stratLabel} · ${confidence}% conf · valid ${ttlMinutes}m` +
      verdictLine + '\n' +
      (poolUrl ? `<a href="${poolUrl}">Buka pool</a> · ` : '') +
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

  boot(port) {
    return this.send(
      `🦅 <b>Argus online</b>\n<a href="http://127.0.0.1:${port}">Dashboard</a>`,
      'P3'
    )
  }
}

module.exports = new TelegramNotifier()
