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
// solscan        : top token holders — DISABLED by default (host retired), see config
// okx            : OKX smart money endpoint (needs okx.apiKey) — DISABLED by default, see config
const SOURCE_ORDER = ['meteora', 'meteora-extended', 'helius', 'solscan', 'okx']

/**
 * Sources switched off in config (wallet.discovery.disabledSources). A disabled source is
 * never attempted, never gets a discovery_sources row, and cannot be revived by the Web UI
 * resume button — config is the authority, so a click can't resurrect a dead integration.
 * Returns a Set for O(1) membership.
 */
function disabledSources() {
  const list = getConfig().wallet?.discovery?.disabledSources
  return new Set(Array.isArray(list) ? list : [])
}

function activeSourceOrder() {
  const off = disabledSources()
  return SOURCE_ORDER.filter(s => !off.has(s))
}

const DEFAULT_COOLDOWN_MS = 6 * 3600 * 1000  // 6 hours
const MAX_COOLDOWN_MS     = 24 * 3600 * 1000  // 24 hours
const AUTO_PAUSE_AFTER    = 5                  // consecutive failures

// ── Source state helpers ──────────────────────────────────────────────────────

function ensureSourceRows() {
  for (const source of activeSourceOrder()) {
    db.prepare(`
      INSERT OR IGNORE INTO discovery_sources (source, cooldown_ms)
      VALUES (?, ?)
    `).run(source, DEFAULT_COOLDOWN_MS)
  }
  // Drop rows left behind by a source that has since been disabled, so the dashboard
  // stops showing its stale failure_count / last_error forever. The row holds only
  // scheduling state (cooldown, backoff) — no history is lost.
  for (const source of disabledSources()) {
    db.prepare('DELETE FROM discovery_sources WHERE source = ?').run(source)
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
  `).run(new Date().toISOString(), failures, newCooldown, String(errMsg || 'unknown error').slice(0, 200), pausedUntil, source)

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
      // Re-discovery resets lifecycle to active (wallet is still out there)
      db.prepare(`
        UPDATE tracked_wallets
        SET pool_hits = MAX(pool_hits, ?), last_seen = ?, lifecycle_state = 'active', active = 1
        WHERE address = ?
      `).run(c.pool_hits || 1, now, addr)
    } else {
      db.prepare(`
        INSERT INTO tracked_wallets (discovered_at, address, label, source, active, lifecycle_state, pool_hits, last_seen)
        VALUES (?, ?, ?, ?, 1, 'active', ?, ?)
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

  for (const sourceName of activeSourceOrder()) {
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
      // "No seed input" (empty decisions/token history — e.g. a fresh install or a scan-less
      // window) is NOT a source outage. Penalizing it with markFailure racks up failure_count
      // and auto-pauses healthy sources for 24h, which can drain the discovery chain down to a
      // single external API (a self-inflicted SPOF). Skip without penalty; only real errors count.
      const noSeed = /no recent (decisions|token)|seed from|run a scan first/i.test(e.message || '')
      if (noSeed) {
        console.log(`[Hivemind] ${sourceName} skipped: ${e.message} (no seed yet — not penalized)`)
      } else {
        console.warn(`[Hivemind] ${sourceName} failed: ${e.message} → trying next source`)
        markFailure(sourceName, e.message)
      }
      // continue to next source in chain
    }
  }

  // Always emit so wallet/index.js hot-add mechanism fires even if no new wallets
  bus.emitSafe('tracked_wallets_updated', { discovered: totalNew })
  if (totalNew > 0) {
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
  if (disabledSources().has(source)) {
    console.log(`[Hivemind] ${source} is disabled in config (wallet.discovery.disabledSources) — resume ignored`)
    return
  }
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

  // Surface config-disabled sources so the dashboard shows "off on purpose" rather than
  // silently omitting an integration the operator may still expect to see.
  for (const source of disabledSources()) {
    if (SOURCE_ORDER.includes(source)) {
      sources.push({ source, state: 'disabled', detail: 'off in config', last_run: null,
                     failure_count: 0, last_error: null, paused_until: null })
    }
  }

  const walletCount = db.prepare('SELECT COUNT(*) as c FROM tracked_wallets WHERE active = 1').get()?.c || 0

  return { sources, wallet_count: walletCount }
}

function getTrackedWallets() {
  return db.prepare(`
    SELECT address, label, source, pool_hits, discovered_at, last_seen, active,
           COALESCE(lifecycle_state, 'active') AS lifecycle_state,
           COALESCE(quality_score, 0.5)        AS quality_score
    FROM tracked_wallets
    ORDER BY COALESCE(quality_score, 0.5) DESC, pool_hits DESC, discovered_at DESC
  `).all()
}

function init() {
  ensureSourceRows()
  console.log('[Hivemind] Discovery system ready')
}

module.exports = { init, runDiscovery, pauseSource, resumeSource, getStatus, getTrackedWallets }
