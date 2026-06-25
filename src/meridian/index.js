'use strict'
// Meridian Integration — allows Argus to feed signals to the Meridian LP bot.
//
// Two modes:
//   PUSH  — Argus webhooks Meridian when a new recommendation is made
//           (set meridian.webhookUrl in user-config.json)
//   PULL  — Meridian polls Argus API endpoints (always available)
//
// Meridian-compatible API:
//   GET  /api/meridian/recommendations     — active decisions, Meridian format
//   GET  /api/meridian/pool/:addr/signal   — quick pool signal check
//   GET  /api/meridian/smart-wallets       — discovered smart wallets (import to Meridian)
//   POST /api/meridian/webhook/test        — test webhook connectivity

const fetch = require('node-fetch')
const db    = require('../db/database')
const { getConfig } = require('../config')

// ── Format helpers ────────────────────────────────────────────────────────────

function formatRecommendation(row) {
  let indicators = null
  let strategy_scores = null
  try { indicators = row.indicators_json ? JSON.parse(row.indicators_json) : null } catch {}
  try { strategy_scores = row.strategy_scores_json ? JSON.parse(row.strategy_scores_json) : null } catch {}

  // Enrich with dry run stats for this pool if available
  const drRow = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN net_pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
           AVG(net_pnl_pct) as avg_pnl,
           AVG(hold_minutes) as avg_hold
    FROM dry_run_positions
    WHERE pool_address = ? AND status = 'closed' AND outcome_valid = 1
  `).get(row.pool_address)

  const dry_run = drRow?.total > 0 ? {
    total:     drRow.total,
    win_rate:  drRow.total > 0 ? Math.round((drRow.wins / drRow.total) * 100) : null,
    avg_pnl:   drRow.avg_pnl != null ? parseFloat(drRow.avg_pnl.toFixed(2)) : null,
    avg_hold_minutes: drRow.avg_hold != null ? Math.round(drRow.avg_hold) : null,
  } : null

  return {
    pool_address:         row.pool_address,
    token_symbol:         row.token_symbol,
    token_mint:           row.token_mint,
    strategy:             row.strategy,
    confidence:           row.confidence,
    condition_bucket:     row.condition_bucket,
    expires_at:           row.expires_at,
    created_at:           row.created_at,
    llm_verdict:          row.llm_verdict,
    smart_money_confirmed: indicators?.smart_money_confirmed || false,
    indicators,
    strategy_scores,
    dry_run,
    source:               'argus',
  }
}

// ── Pull endpoints (always-on) ────────────────────────────────────────────────

function getActiveRecommendations() {
  const rows = db.prepare(`
    SELECT id, created_at, expires_at, token_symbol, token_mint, pool_address,
           strategy, confidence, condition_bucket, llm_verdict,
           indicators_json, strategy_scores_json
    FROM decisions
    WHERE status = 'active'
    ORDER BY confidence DESC, created_at DESC
    LIMIT 20
  `).all()

  return rows.map(formatRecommendation)
}

function getPoolSignal(poolAddress) {
  if (!poolAddress) return { recommended: false, reason: 'No pool address provided' }

  const active = db.prepare(`
    SELECT strategy, confidence, expires_at, condition_bucket, indicators_json, llm_verdict
    FROM decisions
    WHERE pool_address = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).get(poolAddress)

  if (active) {
    let sm = false
    try { sm = JSON.parse(active.indicators_json)?.smart_money_confirmed || false } catch {}
    return {
      recommended:          true,
      strategy:             active.strategy,
      confidence:           active.confidence,
      expires_at:           active.expires_at,
      condition_bucket:     active.condition_bucket,
      smart_money_confirmed: sm,
      llm_verdict:          active.llm_verdict,
      reason:               'Active Argus recommendation',
    }
  }

  // Check recent history (was ever recommended?)
  const historical = db.prepare(`
    SELECT strategy, confidence, status, created_at
    FROM decisions
    WHERE pool_address = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(poolAddress)

  if (historical) {
    return {
      recommended: false,
      reason:      `Previously ${historical.status} (${historical.strategy}, ${new Date(historical.created_at).toLocaleDateString()})`,
      last_seen:   historical.created_at,
    }
  }

  return { recommended: false, reason: 'No Argus recommendation for this pool' }
}

function getSmartWalletsForMeridian() {
  const cfg = getConfig()

  // Combine static config wallets + DB hivemind wallets
  const static_sm = (cfg.wallet?.trackedWallets || []).map(w => ({
    name:      w.label || w.address?.slice(0, 8),
    address:   w.address,
    category:  'alpha',
    type:      'lp',
    source:    'user_config',
    addedAt:   new Date().toISOString(),
  }))

  const db_wallets = db.prepare(`
    SELECT address, label, source, discovered_at
    FROM tracked_wallets WHERE active = 1
    ORDER BY pool_hits DESC
  `).all().map(w => ({
    name:     w.label || w.address?.slice(0, 8),
    address:  w.address,
    category: 'alpha',
    type:     'lp',
    source:   `argus_hivemind_${w.source}`,
    addedAt:  w.discovered_at,
  }))

  // Deduplicate by address
  const seen = new Set()
  const wallets = [...static_sm, ...db_wallets].filter(w => {
    if (!w.address || seen.has(w.address)) return false
    seen.add(w.address)
    return true
  })

  return { wallets, total: wallets.length, generated_at: new Date().toISOString() }
}

// ── Push (webhook) ────────────────────────────────────────────────────────────

async function pushRecommendation(decisionData) {
  const cfg = getConfig()
  const meridianCfg = cfg.meridian || {}

  if (!meridianCfg.enabled || !meridianCfg.webhookUrl) return

  const payload = {
    source:    'argus',
    event:     'new_recommendation',
    ts:        Date.now(),
    argus_url: meridianCfg.argusUrl || null,
    data:      decisionData,
  }

  try {
    const res = await fetch(meridianCfg.webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      timeout: 8_000,
    })
    if (!res.ok) {
      console.warn(`[Meridian] Webhook HTTP ${res.status} — check meridian.webhookUrl`)
    } else {
      console.log(`[Meridian] Pushed recommendation for ${decisionData.token_symbol} → webhook OK`)
    }
  } catch (e) {
    console.warn(`[Meridian] Webhook push failed: ${e.message}`)
  }
}

module.exports = { getActiveRecommendations, getPoolSignal, getSmartWalletsForMeridian, pushRecommendation }
