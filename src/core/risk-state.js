'use strict'
const fs = require('fs')
const path = require('path')

const STATE_FILE = path.join(__dirname, '../../data/risk-state.json')

const DEFAULTS = {
  current_open_count: 0,
  daily_realized_loss_usd: 0,
  daily_unrealized_loss_usd: 0,
  blacklisted_tokens: [],
  blacklisted_deployers: [],
  circuit_breaker_open: false,
  circuit_breaker_reason: null,
  circuit_breaker_opened_at: null,
  last_reset_date: null,
}

// Circuit breaker triggers — any of these conditions opens the breaker
const CIRCUIT_TRIGGERS = {
  FLASH_CRASH: 'flash_crash',           // Vol >3σ + price drop >15% in 5min
  DATA_STALE: 'data_stale',             // Any source returning data older than 60s
  AI_INCONSISTENT: 'ai_inconsistent',   // 3+ contradictory recs in 30min
  DAILY_LOSS: 'daily_loss_limit',       // Daily loss limit breached
  MANUAL: 'manual',                     // User manually opened
}

class RiskState {
  constructor() {
    this.limits = {
      max_open_positions: parseInt(process.env.RISK_MAX_POSITIONS || '5'),
      max_daily_loss_usd: parseFloat(process.env.RISK_MAX_DAILY_LOSS || '50'),
    }
    this._state = this._load()
    this._resetIfNewDay()
  }

  _load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }
      }
    } catch (err) {
      console.warn('[RiskState] Could not load state, using defaults:', err.message)
    }
    return { ...DEFAULTS }
  }

  _save() {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2))
    fs.renameSync(tmp, STATE_FILE)
  }

  _resetIfNewDay() {
    const today = new Date().toISOString().slice(0, 10)
    if (this._state.last_reset_date !== today) {
      this._state.daily_realized_loss_usd = 0
      this._state.daily_unrealized_loss_usd = 0
      this._state.last_reset_date = today
      this._save()
      console.log('[RiskState] Daily counters reset for', today)
    }
  }

  // ── Synchronous gate ─────────────────────────────────────────────────────
  // Called BEFORE any recommendation is shown to the user.
  // Returns { allowed: true } or { allowed: false, reason: string }
  check(tokenMint = null) {
    if (this._state.circuit_breaker_open) {
      return { allowed: false, reason: `Circuit breaker aktif: ${this._state.circuit_breaker_reason}` }
    }
    if (this._state.current_open_count >= this.limits.max_open_positions) {
      return { allowed: false, reason: `Batas ${this.limits.max_open_positions} posisi terbuka sudah tercapai` }
    }
    const totalLoss = this._state.daily_realized_loss_usd + this._state.daily_unrealized_loss_usd
    if (totalLoss >= this.limits.max_daily_loss_usd) {
      return { allowed: false, reason: `Daily loss $${totalLoss.toFixed(2)} melebihi limit $${this.limits.max_daily_loss_usd}` }
    }
    if (tokenMint && this._state.blacklisted_tokens.includes(tokenMint)) {
      return { allowed: false, reason: `Token di-blacklist` }
    }
    return { allowed: true }
  }

  // ── Blacklist ─────────────────────────────────────────────────────────────
  blacklistToken(mint, reason = '') {
    if (!this._state.blacklisted_tokens.includes(mint)) {
      this._state.blacklisted_tokens.push(mint)
      this._save()
      console.log(`[RiskState] Token blacklisted: ${mint.slice(0, 8)}… reason: ${reason}`)
    }
  }

  blacklistDeployer(address, reason = '') {
    if (!this._state.blacklisted_deployers.includes(address)) {
      this._state.blacklisted_deployers.push(address)
      this._save()
      console.log(`[RiskState] Deployer blacklisted: ${address.slice(0, 8)}… reason: ${reason}`)
    }
  }

  isTokenBlacklisted(mint) { return this._state.blacklisted_tokens.includes(mint) }
  isDeployerBlacklisted(addr) { return this._state.blacklisted_deployers.includes(addr) }

  // ── Circuit Breaker ───────────────────────────────────────────────────────
  openCircuitBreaker(trigger, detail = '') {
    const reason = `${trigger}${detail ? ': ' + detail : ''}`
    this._state.circuit_breaker_open = true
    this._state.circuit_breaker_reason = reason
    this._state.circuit_breaker_opened_at = new Date().toISOString()
    this._save()
    console.error('[RiskState] ⛔ CIRCUIT BREAKER OPEN:', reason)
    // Emit event so UI and Telegram know immediately
    try { require('./event-bus').emitSafe('risk_gate_blocked', { reason }) } catch {}
  }

  resetCircuitBreaker() {
    this._state.circuit_breaker_open = false
    this._state.circuit_breaker_reason = null
    this._state.circuit_breaker_opened_at = null
    this._save()
    console.log('[RiskState] ✅ Circuit breaker reset')
  }

  // ── Position Counters ─────────────────────────────────────────────────────
  incrementOpenCount() {
    this._state.current_open_count++
    this._save()
  }

  decrementOpenCount() {
    this._state.current_open_count = Math.max(0, this._state.current_open_count - 1)
    this._save()
  }

  // ── Loss Tracking ─────────────────────────────────────────────────────────
  recordRealizedLoss(usd) {
    this._state.daily_realized_loss_usd += Math.abs(usd)
    this._save()
    const total = this._state.daily_realized_loss_usd + this._state.daily_unrealized_loss_usd
    if (total >= this.limits.max_daily_loss_usd) {
      this.openCircuitBreaker(CIRCUIT_TRIGGERS.DAILY_LOSS, `$${total.toFixed(2)} loss today`)
    }
  }

  updateUnrealizedLoss(usd) {
    this._state.daily_unrealized_loss_usd = Math.max(0, usd)
    this._save()
  }

  get state() { return { ...this._state, limits: this.limits } }
  get triggers() { return CIRCUIT_TRIGGERS }
}

module.exports = new RiskState()
