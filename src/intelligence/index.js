'use strict'
const bus = require('../core/event-bus')
const riskState = require('../core/risk-state')
const { recordDecision } = require('../db/schema')
const { getTopCandidates } = require('./screener')
const { chooseStrategy, scoreStrategies } = require('./strategy-router')
const { getConfig } = require('../config')
const { parseBucket }      = require('../learning/pattern-updater')
const { getPattern, adjustScore } = require('../learning/pattern-reader')
const { generateVerdict }  = require('../ai/verdict-generator')

let _scanning = false

/**
 * Classify a pool into a condition bucket for Pattern Library lookup.
 * Format: "<volBucket>_vol_<feeBucket>_yield_<regime>"
 */
function conditionBucket(pool) {
  const vol = pool.volatility ?? 0
  const feeTvl = pool.fee_active_tvl_ratio ?? 0
  const pricePct = pool.price_change_pct ?? 0
  const volPct = pool.volume_change_pct ?? 0

  const volBucket = vol > 2 ? 'high' : vol > 1 ? 'medium' : 'low'
  const feeBucket = feeTvl > 0.3 ? 'high' : feeTvl > 0.1 ? 'medium' : 'low'
  const regime = pricePct > 5 && volPct > 30 ? 'recovery'
    : pricePct < -5 ? 'decline'
    : feeTvl > 0.3 ? 'froth'
    : 'neutral'

  return `${volBucket}_vol_${feeBucket}_yield_${regime}`
}

/**
 * Calculate TTL in minutes based on volatility.
 * High-vol tokens expire faster — their opportunity windows shrink faster.
 */
function calcTtlMinutes(pool) {
  const vol = pool.volatility ?? 0
  if (vol > 2.5) return 10
  if (vol > 1.5) return 20
  return 30
}

/**
 * Run a full screening + strategy routing cycle.
 * Called automatically by the scheduler every 15 minutes.
 */
async function runScan() {
  if (_scanning) {
    console.log('[IC] Scan in progress — skipping duplicate trigger')
    return null
  }
  _scanning = true
  const started = Date.now()
  console.log('[IC] ── Scan started ──')

  try {
    // Synchronous risk gate — check before any network calls
    const gate = riskState.check()
    if (!gate.allowed) {
      console.log(`[IC] Scan blocked by risk gate: ${gate.reason}`)
      bus.emitSafe('risk_gate_blocked', { reason: gate.reason })
      return null
    }

    const cfg = getConfig()
    const { candidates, total_screened, filtered_examples } = await getTopCandidates({
      limit: cfg.scan?.topCandidateLimit ?? 10,
    })

    const decisions = []

    for (const pool of candidates) {
      // Per-token gate check
      const tokenGate = riskState.check(pool.base?.mint)
      if (!tokenGate.allowed) {
        console.log(`[IC] ${pool.base?.symbol} blocked: ${tokenGate.reason}`)
        continue
      }

      // Skip pools that already have an active decision — avoid stacking duplicates
      const db = require('../db/database')
      const existing = db.prepare(
        `SELECT id FROM decisions WHERE pool_address = ? AND status = 'active' LIMIT 1`
      ).get(pool.pool)
      if (existing) {
        console.log(`[IC] ${pool.base?.symbol} already has active decision #${existing.id} — skip`)
        continue
      }

      const allScores = scoreStrategies(pool, cfg)
      const best = chooseStrategy(pool, cfg)
      const ttlMinutes = calcTtlMinutes(pool)
      const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString()
      const bucket = conditionBucket(pool)

      // Pattern Library: adjust confidence based on historical win rate
      const { volatility_bucket, regime } = parseBucket(bucket)
      const pattern = getPattern(volatility_bucket, regime, best.strategy)
      const confidence = adjustScore(best.score, pattern)
      if (pattern?.active) {
        console.log(`[IC] Pattern ${volatility_bucket}×${regime}×${best.strategy}: win=${(pattern.win_rate*100).toFixed(0)}% N=${pattern.sample_count} → confidence ${(best.score*100).toFixed(0)}→${(confidence*100).toFixed(0)}`)
      }

      const indicators = {
        volatility: pool.volatility,
        fee_active_tvl_ratio: pool.fee_active_tvl_ratio,
        volume_change_pct: pool.volume_change_pct,
        price_change_pct: pool.price_change_pct,
        organic_score: pool.organic_score,
        holders: pool.holders,
        price_vs_ath_pct: pool.price_vs_ath_pct,
        smart_money_buy: pool.smart_money_buy ?? null,
        dev_sold_all: pool.dev_sold_all ?? null,
        risk_level: pool.risk_level ?? null,
        top10_pct: pool.top10_pct ?? null,
        dex_boost: pool.dex_boost ?? null,
        bin_step: pool.bin_step,
        tvl: pool.tvl,
        fee_window: pool.fee_window,
        volume_window: pool.volume_window,
      }

      try {
        const result = recordDecision({
          created_at: new Date().toISOString(),
          expires_at: expiresAt,
          token_mint: pool.base?.mint,
          token_symbol: pool.base?.symbol,
          pool_address: pool.pool,
          strategy: best.strategy,
          indicators_json: JSON.stringify(indicators),
          strategy_scores_json: JSON.stringify(allScores),
          llm_verdict: null,
          confidence,
          condition_bucket: bucket,
        })

        const decisionId = result.lastInsertRowid
        decisions.push({ id: decisionId, pool, strategy: best.strategy, score: best.score, ttlMinutes, expiresAt, bucket })

        // Open a dry run position immediately so we start tracking P&L
        const dryRun = require('../dry-run/engine')
        dryRun.openForDecision(decisionId, pool, best.strategy)

        // Fire-and-forget LLM verdict (only if AI enabled in config)
        if (cfg.ai?.enabled) {
          generateVerdict(decisionId, pool, best.strategy, bucket, indicators, cfg.ai)
        }

        const elig = allScores.filter(s => s.eligible).map(s => s.strategy).join('/')
        const patStr = pattern?.active ? ` [hist ${(pattern.win_rate*100).toFixed(0)}%/${pattern.sample_count}]` : ''
        console.log(`[IC] #${decisionId} ${pool.base?.symbol} → ${best.strategy} (conf=${(confidence*100).toFixed(0)}, ttl=${ttlMinutes}m, elig: ${elig || 'none'}${patStr})`)
      } catch (e) {
        console.error(`[IC] Failed to record decision for ${pool.base?.symbol}:`, e.message)
      }
    }

    const elapsed = Date.now() - started
    console.log(`[IC] ── Scan done in ${elapsed}ms: ${total_screened} screened → ${candidates.length} passed → ${decisions.length} decisions ──`)

    // Push results to frontend via WebSocket
    bus.emitSafe('ui_update', {
      type: 'scan_result',
      ts: new Date().toISOString(),
      total_screened,
      candidates: candidates.length,
      decisions: decisions.length,
      elapsed_ms: elapsed,
    })

    return { decisions, total_screened, elapsed_ms: elapsed }
  } catch (err) {
    console.error('[IC] Scan error:', err.message)
    bus.emitSafe('ui_update', { type: 'scan_error', error: err.message })
    throw err
  } finally {
    _scanning = false
  }
}

/**
 * Initialize the Intelligence Core.
 * Wires into the event bus: scan_complete (scheduler trigger) → runScan().
 * TTL check → expire stale decisions.
 */
function init() {
  // The scheduler emits scan_complete every 15min as a trigger.
  // Guard: only act on scheduler-originated triggers (not IC's own ui_update emissions).
  bus.onFast('scan_complete', payload => {
    if (payload?.trigger !== 'scheduled') return
    runScan().catch(err => console.error('[IC] Background scan failed:', err.message))
  })

  // TTL check: expire decisions past their expires_at timestamp
  bus.onFast('ttl_check', () => {
    try {
      const db = require('../db/database')
      const result = db.prepare(
        `UPDATE decisions SET status = 'expired' WHERE status = 'active' AND expires_at < ?`
      ).run(new Date().toISOString())
      if (result.changes > 0) {
        console.log(`[IC] Expired ${result.changes} decision(s)`)
        bus.emitSafe('recommendation_expired', { count: result.changes })
      }
    } catch (e) {
      console.error('[IC] TTL check error:', e.message)
    }
  })

  console.log('[IC] Intelligence Core ready (scan every 15min)')
}

module.exports = { init, runScan }
