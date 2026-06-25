'use strict'
// Hivemind Discovery — automatically finds smart money wallets from multiple
// on-chain/off-chain sources. Feeds into wallet_actions observer as live signals.
//
// Source priority order: try each source in sequence, stop at first success.
// On failure: exponential backoff (cooldown ×2, max 24h). Auto-pause after 5 failures.
// Manual pause/resume available via Web UI → /api/hivemind/source/:name/pause|resume

const db  = require('../db/database')
const bus = require('../core/event-bus')
const { getConfig } = require('../config')

// Priority order — first source that succeeds wins this cycle.
// meteora        : on-chain, seeds from Argus decisions, zero API key
// meteora-extended: on-chain, seeds from Pool Discovery API top pools
// helius         : enhanced API (needs helius.apiKey), cleanest LP detection
// solscan        : top token holders, no key, lowest signal precision
// okx            : OKX smart money endpoint (needs okx.apiKey)
const SOURCE_ORDER = ['meteora', 'meteora-extended', 'helius', 'solscan', 'okx']

const DEFAULT_COOLDOWN_MS = 6 * 3600 * 1000  // 6 hours
const MAX_COOLDOWN_MS     = 24 * 3600 * 1000  // 24 hours
const AUTO_PAUSE_AFTER    = 5                  // consecutive failures

// ── Source state helpers ──────────────────────────────────────────────────────

function ensureSourceRows() {
  for (const source of SOURCE_ORDER) {
    db.prepare(`
      INSERT OR IGNORE INTO discovery_sources (source, cooldown_ms)
      VALUES (?, ?)
    `).run(source, DEFAULT_COOLDOWN_MS)
  }
}

function getSourceState(source) {
  return db.prepare('SELECT * FROM discovery_sources WHERE source = ?').get(source)
}

function canRunSource(source) {
  const row = getSourceState(source)
  if (!row) return { ok: false, reason: 'unknown source' }

  const now = Date.now()

  // Manual/auto pause check
  if (row.paused_until && new Date(row.paused_until).getTime() > now) {
    const mins = Math.ceil((new Date(row.paused_until).getTime() - now) / 60_000)
    return { ok: false, reason: `paused ${mins}min remaining` }
  }

  // Cooldown check
  if (row.last_run) {
    const elapsed = now - new Date(row.last_run).getTime()
    if (elapsed < row.cooldown_ms) {
      const mins = Math.ceil((row.cooldown_ms - elapsed) / 60_000)
      return { ok: false, reason: `cooldown ${mins}min left` }
    }
  }

  return { ok: true }
}

function markSuccess(source) {
  db.prepare(`
    UPDATE discovery_sources
    SET last_run = ?, failure_count = 0, cooldown_ms = ?, last_error = NULL, paused_until = NULL
    WHERE source = ?
  `).run(new Date().toISOString(), DEFAULT_COOLDOWN_MS, source)
}

function markFailure(source, errMsg) {
  const row = getSourceState(source)
  const failures  = (row?.failure_count || 0) + 1
  const newCooldown = Math.min((row?.cooldown_ms || DEFAULT_COOLDOWN_MS) * 2, MAX_COOLDOWN_MS)
  // Auto-pause for 24h after too many consecutive failures
  const pausedUntil = failures >= AUTO_PAUSE_AFTER
    ? new Date(Date.now() + MAX_COOLDOWN_MS).toISOString()
    : null

  db.prepare(`
    UPDATE discovery_sources
    SET last_run = ?, failure_count = ?, cooldown_ms = ?, last_error = ?, paused_until = ?
    WHERE source = ?
  `).run(new Date().toISOString(), failures, newCooldown, errMsg.slice(0, 200), pausedUntil, source)

  if (failures >= AUTO_PAUSE_AFTER) {
    console.warn(`[Hivemind] ${source} auto-paused 24h after ${failures} failures`)
  }
}

// ── Wallet upsert ─────────────────────────────────────────────────────────────

function upsertWallets(candidates, source) {
  const cfg = getConfig()
  const ownAddr = (cfg.wallet?.address || '').toLowerCase()
  const staticAddrs = new Set(
    (cfg.wallet?.trackedWallets || []).map(w => (w.address || '').toLowerCase())
  )

  let added = 0
  const now = new Date().toISOString()

  for (const c of candidates) {
    if (!c?.address) continue
    const addr = c.address.trim()

    // Skip own wallet and already-static wallets
    if (addr.toLowerCase() === ownAddr) continue
    if (staticAddrs.has(addr.toLowerCase())) continue

    const existing = db.prepare('SELECT id, pool_hits FROM tracked_wallets WHERE address = ?').get(addr)
    if (existing) {
      db.prepare(`
        UPDATE tracked_wallets SET pool_hits = MAX(pool_hits, ?), last_seen = ? WHERE address = ?
      `).run(c.pool_hits || 1, now, addr)
    } else {
      db.prepare(`
        INSERT INTO tracked_wallets (discovered_at, address, label, source, active, pool_hits, last_seen)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(now, addr, c.label || addr.slice(0, 8), source, c.pool_hits || 1, now)
      added++
    }
  }

  return added
}

// ── Source runners ────────────────────────────────────────────────────────────

async function runSource(name, ctx) {
  switch (name) {
    case 'meteora': {
      const { discoverFromMeteora } = require('./sources/meteora-source')
      return discoverFromMeteora(ctx)
    }
    case 'meteora-extended': {
      const { discoverFromMeteoraExtended } = require('./sources/meteora-extended-source')
      return discoverFromMeteoraExtended(ctx)
    }
    case 'helius': {
      const { discoverFromHelius } = require('./sources/helius-source')
      return discoverFromHelius(ctx)
    }
    case 'solscan': {
      const { discoverFromSolscan } = require('./sources/solscan-source')
      return discoverFromSolscan(ctx)
    }
    case 'okx': {
      const { discoverFromOkx } = require('./sources/okx-source')
      return discoverFromOkx(ctx)
    }
    default:
      throw new Error(`Unknown source: ${name}`)
  }
}

// ── Main discovery cycle ──────────────────────────────────────────────────────

async function runDiscovery() {
  ensureSourceRows()

  const cfg    = getConfig()
  const rpcUrl = cfg.wallet?.rpcUrl || 'https://api.mainnet-beta.solana.com'
  const ctx    = { rpcUrl, cfg }

  console.log('[Hivemind] Discovery cycle started')
  let totalNew = 0

  for (const sourceName of SOURCE_ORDER) {
    const check = canRunSource(sourceName)
    if (!check.ok) {
      console.log(`[Hivemind] ${sourceName}: ${check.reason} — skip`)
      continue
    }

    try {
      console.log(`[Hivemind] Trying ${sourceName}...`)
      const candidates = await runSource(sourceName, ctx)
      markSuccess(sourceName)

      const added = upsertWallets(candidates, sourceName)
      totalNew += added
      console.log(`[Hivemind] ${sourceName}: ${candidates.length} candidates → ${added} new wallet(s)`)

      // Stop at first successful source
      break
    } catch (e) {
      console.warn(`[Hivemind] ${sourceName} failed: ${e.message} → trying next source`)
      markFailure(sourceName, e.message)
      // continue to next source in chain
    }
  }

  if (totalNew > 0) {
    bus.emitSafe('tracked_wallets_updated', { discovered: totalNew })
    console.log(`[Hivemind] ${totalNew} new smart money wallet(s) added to tracker`)
  } else {
    console.log('[Hivemind] Discovery cycle complete — no new wallets found')
  }

  return totalNew
}

// ── Manual controls ───────────────────────────────────────────────────────────

function pauseSource(source, durationMs = MAX_COOLDOWN_MS) {
  ensureSourceRows()
  const pausedUntil = new Date(Date.now() + durationMs).toISOString()
  db.prepare(`UPDATE discovery_sources SET paused_until = ? WHERE source = ?`)
    .run(pausedUntil, source)
  console.log(`[Hivemind] ${source} manually paused until ${pausedUntil}`)
}

function resumeSource(source) {
  ensureSourceRows()
  db.prepare(`
    UPDATE discovery_sources
    SET paused_until = NULL, failure_count = 0, cooldown_ms = ?, last_error = NULL
    WHERE source = ?
  `).run(DEFAULT_COOLDOWN_MS, source)
  console.log(`[Hivemind] ${source} resumed`)
}

function getStatus() {
  ensureSourceRows()
  const now = Date.now()
  const sources = db.prepare('SELECT * FROM discovery_sources').all().map(row => {
    let state = 'ready'
    let detail = ''

    if (row.paused_until && new Date(row.paused_until).getTime() > now) {
      const mins = Math.ceil((new Date(row.paused_until).getTime() - now) / 60_000)
      state  = 'paused'
      detail = `${mins}min left`
    } else if (row.last_run) {
      const elapsed = now - new Date(row.last_run).getTime()
      if (elapsed < row.cooldown_ms) {
        const mins = Math.ceil((row.cooldown_ms - elapsed) / 60_000)
        state  = 'cooldown'
        detail = `${mins}min left`
      }
    }

    return {
      source:        row.source,
      state,
      detail,
      last_run:      row.last_run,
      failure_count: row.failure_count,
      last_error:    row.last_error,
      paused_until:  row.paused_until,
    }
  })

  const walletCount = db.prepare('SELECT COUNT(*) as c FROM tracked_wallets WHERE active = 1').get()?.c || 0

  return { sources, wallet_count: walletCount }
}

function getTrackedWallets() {
  return db.prepare(`
    SELECT address, label, source, pool_hits, discovered_at, last_seen, active
    FROM tracked_wallets ORDER BY pool_hits DESC, discovered_at DESC
  `).all()
}

function init() {
  ensureSourceRows()
  console.log('[Hivemind] Discovery system ready')
}

module.exports = { init, runDiscovery, pauseSource, resumeSource, getStatus, getTrackedWallets }
