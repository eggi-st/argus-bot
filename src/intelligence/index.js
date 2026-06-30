'use strict'
const bus = require('../core/event-bus')
const riskState = require('../core/risk-state')
const { recordDecision } = require('../db/schema')
const { getTopCandidates } = require('./screener')
const { scoreStrategies } = require('./strategy-router')
const { enrichWithIndicators, enrichSpotIndicators } = require('./chart-indicators')
const { techniqueAuthor } = require('./techniques')
const { getConfig } = require('../config')
const { parseBucket }      = require('../learning/pattern-updater')
const { getPattern, adjustScore } = require('../learning/pattern-reader')
const { generateVerdict }  = require('../ai/verdict-generator')
const telegram             = require('../notifications/telegram')
const db                   = require('../db/database')
const dryRun               = require('../dry-run/engine')

let _scanning = false

const round3 = x => (x == null ? null : Math.round(x * 1000) / 1000)

/**
 * Wilson score lower bound for a binomial proportion (win rate).
 * Widens the interval for small N, so a high point-estimate on thin data
 * does NOT pass the gate until enough samples confirm it.
 * z controls confidence: 1.0 ≈ one std-error (pragmatic), 1.96 ≈ 95%.
 */
function wilsonLowerBound(p, n, z = 1.0) {
  if (!n || n <= 0) return 0
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = p + z2 / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
  return Math.max(0, (center - margin) / denom)
}

/**
 * Gate: should this (strategy × pattern) combination be blocked?
 *
 * Applied only once a pattern is ACTIVE (promoted at N >= PROMOTION_THRESHOLD).
 * Calibrating patterns are never blocked — we need samples to learn.
 *
 * Rules (active patterns):
 *   1. confidence < minConfidence — rule-based score also rejected it
 *   2. Wilson lower bound of win_rate < minWinRate — no statistically-supported edge.
 *      Using the lower bound (not the raw win_rate) closes the old dead-zone where a
 *      clearly-bad pattern (e.g. WR=29%, N=24) escaped the gate purely by being under
 *      a hard N>=minSamples muzzle.
 *   3. mean_pnl_net < minMeanPnl — avg P&L negative even with some wins.
 */
function checkPatternGate(pattern, confidence, gateCfg = {}) {
  const minWinRate    = gateCfg.minWinRate    ?? 0.35
  const minMeanPnl    = gateCfg.minMeanPnl    ?? -1.0
  const minConfidence = gateCfg.minConfidence ?? 0.15
  const minPayoffRatio = gateCfg.minPayoffRatio ?? 0.5   // avg_win must be >= 0.5× avg_loss
  const wilsonZ       = gateCfg.wilsonZ       ?? 1.0

  if (confidence < minConfidence) {
    return { blocked: true, reason: `confidence ${(confidence * 100).toFixed(0)}% < floor ${minConfidence * 100}%` }
  }
  if (!pattern?.active) {
    return { blocked: false }  // calibrating — explore freely to gather samples
  }
  const lb = wilsonLowerBound(pattern.win_rate ?? 0, pattern.sample_count ?? 0, wilsonZ)
  if (lb < minWinRate) {
    return { blocked: true, reason: `WR ${(((pattern.win_rate ?? 0)) * 100).toFixed(0)}% (95%LB ${(lb * 100).toFixed(0)}%) < min ${minWinRate * 100}% (N=${pattern.sample_count})` }
  }
  if (pattern.mean_pnl_net != null && pattern.mean_pnl_net < minMeanPnl) {
    return { blocked: true, reason: `mean P&L ${pattern.mean_pnl_net.toFixed(1)}% < min ${minMeanPnl}% (N=${pattern.sample_count})` }
  }
  // Payoff ratio gate: avg_win / |avg_loss| must meet a minimum threshold.
  // Catches strategies with deceptively-high win rates where losses dwarf wins
  // (e.g. WR=65%, avg_win=+0.4%, avg_loss=−8% → EV negative despite "decent" WR).
  if (pattern.avg_win_pnl != null && pattern.avg_loss_pnl != null && pattern.avg_loss_pnl < 0) {
    const ratio = pattern.avg_win_pnl / Math.abs(pattern.avg_loss_pnl)
    if (ratio < minPayoffRatio) {
      return { blocked: true, reason: `payoff ${ratio.toFixed(2)}× < min ${minPayoffRatio}× (avg win +${pattern.avg_win_pnl.toFixed(1)}% / avg loss ${pattern.avg_loss_pnl.toFixed(1)}%)` }
    }
  }
  return { blocked: false }
}

/**
 * Classify a pool into a condition bucket for Pattern Library lookup.
 * Format: "<volBucket>_vol_<feeBucket>_yield_<regime>_<ageBucket>"
 * Age thresholds: new (<48h), established (48h–168h), veteran (>168h).
 * Null token_age_hours (data unavailable) is treated as 'new'.
 */
function conditionBucket(pool) {
  const vol      = pool.volatility ?? 0
  const feeTvl   = pool.fee_active_tvl_ratio ?? 0
  const pricePct = pool.price_change_pct ?? 0
  const volPct   = pool.volume_change_pct ?? 0
  const ageHours = pool.token_age_hours ?? 0

  const volBucket = vol > 2 ? 'high' : vol > 1 ? 'medium' : 'low'
  const feeBucket = feeTvl > 0.3 ? 'high' : feeTvl > 0.1 ? 'medium' : 'low'
  const regime    = pricePct > 5 && volPct > 30 ? 'recovery'
    : pricePct < -5 ? 'decline'
    : feeTvl > 0.3 ? 'froth'
    : 'neutral'
  const ageBucket = ageHours < 48 ? 'new' : ageHours < 168 ? 'established' : 'veteran'

  return `${volBucket}_vol_${feeBucket}_yield_${regime}_${ageBucket}`
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
 * Liquidity-concentration confidence modifier (Tier 1-B). Returns a multiplicative factor
 * in [floor, 1] that softly discounts pools sitting in the riskier liquidity zone — high
 * tvl/mcap (exit-liquidity trap) or high tvl-per-holder (concentrated liquidity vs community).
 * Applied ONLY to pools that already passed the hard antirug gate, so it adds gradient without
 * loosening safety. Both terms are empirically grounded (winners vs catastrophes, 84 closes).
 */
function liquidityModifier(pool, cfg) {
  const m = cfg.learning?.liquidityModifier
  if (!m || m.enabled === false) return { factor: 1, note: null }
  const fin = x => (x != null && Number.isFinite(Number(x))) ? Number(x) : null
  const tvl = fin(pool.tvl), mcap = fin(pool.mcap), holders = fin(pool.holders)
  let factor = 1
  const notes = []
  if (tvl != null && mcap != null && mcap > 0) {
    const ratio = tvl / mcap
    if (ratio > m.tvlMcapClean) {
      const span = Math.max(1e-9, m.tvlMcapGate - m.tvlMcapClean)
      const frac = Math.min(1, (ratio - m.tvlMcapClean) / span)
      factor *= (1 - frac * m.tvlMcapMaxPenalty)
      notes.push(`tvl/mcap=${ratio.toFixed(3)}`)
    }
  }
  if (tvl != null && holders != null && holders > 0) {
    const tph = tvl / holders
    if (tph > m.tvlPerHolderClean) {
      const span = Math.max(1e-9, m.tvlPerHolderHigh - m.tvlPerHolderClean)
      const frac = Math.min(1, (tph - m.tvlPerHolderClean) / span)
      factor *= (1 - frac * m.tvlPerHolderMaxPenalty)
      notes.push(`tvl/holder=${tph.toFixed(0)}`)
    }
  }
  factor = Math.max(m.floor ?? 0.8, factor)
  return { factor, note: notes.length ? notes.join(' ') : null }
}

/**
 * Token-age confidence modifier (Tier 1-B+). Returns a multiplicative factor in [1-maxPenalty, 1]
 * that discounts pools younger than safeAgeHours — the catastrophe zone (real data: catas rate is
 * elevated <72h, ≈0 above). Full confidence at ≥safeAgeHours; ramps to the floor toward youngAgeHours.
 * Independent of the liquidity terms (age~mcap corr 0.05) so it does not double-count.
 */
function ageModifier(pool, cfg) {
  const m = cfg.learning?.ageModifier
  if (!m || m.enabled === false) return { factor: 1, note: null }
  const age = (pool.token_age_hours != null && Number.isFinite(Number(pool.token_age_hours))) ? Number(pool.token_age_hours) : null
  if (age == null || age >= m.safeAgeHours) return { factor: 1, note: null }
  const span = Math.max(1e-9, m.safeAgeHours - m.youngAgeHours)
  const frac = Math.min(1, Math.max(0, (m.safeAgeHours - age) / span))
  const factor = Math.max(1 - m.maxPenalty, 1 - frac * m.maxPenalty)
  return { factor, note: `age=${age.toFixed(0)}h<${m.safeAgeHours}h` }
}

/**
 * Resolve the screening config for a pipeline profile.
 * The base `screening` block is the default / bid_ask profile; named profiles
 * shallow-override it (all screening values are scalar, so a shallow merge is exact).
 */
function resolveScreening(cfg, profileKey) {
  const base = { ...(cfg.screening || {}) }
  delete base.profiles
  const override = cfg.screening?.profiles?.[profileKey]
  const merged = override ? { ...base, ...override } : base
  // Single source of truth for each strategy's vol cap, so the screener and the router can
  // never drift apart (spot ← strategy.spotMaxVolatility, limit_order ← limitOrder.maxVolatility).
  if (profileKey === 'spot' && cfg.strategy?.spotMaxVolatility != null) {
    merged.maxVolatility = cfg.strategy.spotMaxVolatility
  } else if (profileKey === 'limit_order' && cfg.limitOrder?.maxVolatility != null) {
    merged.maxVolatility = cfg.limitOrder.maxVolatility
  }
  return merged
}

/**
 * Score, gate, and (if it passes) record a decision for ONE pool under ONE pipeline.
 * The pipeline forces `forceStrategy` — it records only that strategy, so each strategy
 * accumulates samples from its own universe instead of bid_ask winning a single pool.
 * exploration=true: bypass the active-pattern statistical gate (guarantees sample collection).
 * Returns a decision summary, or null if the pool was skipped/gated/ineligible.
 */
function processPool(pool, cfg, forceStrategy, { exploration = false } = {}) {
  // Per-token gate check
  const tokenGate = riskState.check(pool.base?.mint)
  if (!tokenGate.allowed) {
    console.log(`[IC] ${pool.base?.symbol} blocked: ${tokenGate.reason}`)
    return null
  }

  // Skip pools that already have an active decision — avoid stacking duplicates (also
  // dedups across pipelines: a pool claimed by one pipeline won't be re-recorded by another)
  const existing = db.prepare(
    `SELECT id FROM decisions WHERE pool_address = ? AND status = 'active' LIMIT 1`
  ).get(pool.pool)
  if (existing) {
    console.log(`[IC] ${pool.base?.symbol} already has active decision #${existing.id} — skip`)
    return null
  }

  const allScores = scoreStrategies(pool, cfg)
  const ttlMinutes = calcTtlMinutes(pool)
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString()
  const bucket = conditionBucket(pool)
  const { volatility_bucket, fee_bucket, regime, age_bucket } = parseBucket(bucket)
  const gateCfg = cfg.learning?.confidenceGate ?? {}
  const gateEnabled = gateCfg.enabled !== false

  // This pipeline only considers its own strategy.
  const score = allScores.find(s => s.strategy === forceStrategy)
  if (!score || !score.eligible) {
    console.log(`[IC] ${pool.base?.symbol} ${forceStrategy} not eligible (${score?.reason || 'unknown'}) — skip`)
    return null
  }

  const pat = getPattern(volatility_bucket, regime, forceStrategy, fee_bucket, age_bucket)
  const adj = adjustScore(score.score, pat, cfg, forceStrategy)
  if (pat?.active) {
    console.log(`[IC] Pattern ${volatility_bucket}×${regime}×${fee_bucket}×${age_bucket}×${forceStrategy}: WR=${(pat.win_rate*100).toFixed(0)}% N=${pat.sample_count} → ${(score.score*100).toFixed(0)}→${(adj*100).toFixed(0)}%`)
  }
  if (gateEnabled) {
    if (!exploration) {
      const gate = checkPatternGate(pat, adj, gateCfg)
      if (gate.blocked) {
        console.log(`[IC] Gate blocked ${pool.base?.symbol} ${forceStrategy}: ${gate.reason}`)
        return null
      }
    } else {
      // Exploration mode: skip active-pattern statistical gates, but keep the confidence floor
      // so we don't open on genuinely terrible candidates.
      const minConfidence = gateCfg.minConfidence ?? 0.15
      if (adj < minConfidence) {
        console.log(`[IC] Exploration skipped ${pool.base?.symbol} (conf ${(adj*100).toFixed(0)}% < floor ${minConfidence*100}%)`)
        return null
      }
    }
  }

  let confidence = adj
  const pattern = pat

  // Decision-trace (#7): record the confidence build-up verbatim so the "why" is auditable.
  const trace = [{ step: 'base_score', value: round3(score.score), detail: `${forceStrategy} rule score` }]
  if (pat) {
    trace.push({ step: 'pattern_adjust', value: round3(adj), factor: null,
      detail: pat.active
        ? `${volatility_bucket}×${regime}×${forceStrategy} active WR ${(pat.win_rate*100||0).toFixed(0)}% N=${pat.sample_count} (${pat.source||'sim'})`
        : `pattern calibrating (N=${pat.sample_count||0}) → shrink toward base rate` })
  }

  // Smart money confirmation: boost confidence if a tracked wallet recently LP'd this pool
  let smartMoneyConfirmed = false
  try {
    const smRow = db.prepare(`
      SELECT COUNT(DISTINCT wallet_address) as cnt
      FROM wallet_actions
      WHERE pool_address = ?
        AND wallet_type = 'smart_money'
        AND detected_at > datetime('now', '-24 hours')
        AND action_type IN ('add_liquidity', 'open_position')
    `).get(pool.pool)
    if ((smRow?.cnt || 0) > 0) {
      smartMoneyConfirmed = true
      confidence = Math.min(1, confidence * 1.15)
      trace.push({ step: 'smart_money', value: round3(confidence), factor: 1.15, detail: `${smRow.cnt} smart wallet(s) LP'd in 24h` })
      console.log(`[IC] 🐋 Smart money signal: ${smRow.cnt} wallet(s) in ${pool.base?.symbol} → conf boosted to ${(confidence*100).toFixed(0)}`)
    }
  } catch (e) {
    console.warn('[IC] Smart money check failed:', e.message)
  }

  // Soft indicator boost for spot (non-blocking — attribution + small confidence lift).
  // For limit_order, the lo_indicator gate is applied in the strategy router instead.
  if (pool.entry_indicator && !pool.entry_indicator.skipped && pool.entry_indicator.confirmed) {
    confidence = Math.min(1, confidence * 1.10)
    pool.entry_technique = pool.entry_indicator.technique
    trace.push({ step: 'entry_indicator', value: round3(confidence), factor: 1.10, detail: `${pool.entry_indicator.technique} confirmed` })
    console.log(`[IC] Entry indicator confirmed (${pool.entry_indicator.technique}): ${pool.base?.symbol} → conf boosted to ${(confidence * 100).toFixed(0)}%`)
  }

  // Liquidity-concentration penalty (Tier 1-B) — soft discount within the antirug-allowed zone.
  const liqMod = liquidityModifier(pool, cfg)
  if (liqMod.factor < 1) {
    confidence = confidence * liqMod.factor
    trace.push({ step: 'liquidity_penalty', value: round3(confidence), factor: round3(liqMod.factor), detail: liqMod.note })
    console.log(`[IC] Liquidity penalty ×${liqMod.factor.toFixed(2)} (${liqMod.note}): ${pool.base?.symbol} → conf ${(confidence * 100).toFixed(0)}%`)
  }

  // Token-age penalty (Tier 1-B+) — discount pools in the young catastrophe zone (<safeAgeHours).
  const ageMod = ageModifier(pool, cfg)
  if (ageMod.factor < 1) {
    confidence = confidence * ageMod.factor
    trace.push({ step: 'age_penalty', value: round3(confidence), factor: round3(ageMod.factor), detail: ageMod.note })
    console.log(`[IC] Age penalty ×${ageMod.factor.toFixed(2)} (${ageMod.note}): ${pool.base?.symbol} → conf ${(confidence * 100).toFixed(0)}%`)
  }
  trace.push({ step: 'final', value: round3(confidence), detail: exploration ? 'exploration quota (gate bypassed)' : 'gate passed' })

  const tvlMcapRatio = (pool.tvl != null && pool.mcap > 0) ? Math.round((pool.tvl / pool.mcap) * 10000) / 10000 : null
  const tvlPerHolder = (pool.tvl != null && pool.holders > 0) ? Math.round((pool.tvl / pool.holders) * 100) / 100 : null
  const indicators = {
    volatility: pool.volatility,
    fee_active_tvl_ratio: pool.fee_active_tvl_ratio,
    volume_change_pct: pool.volume_change_pct,
    price_change_pct: pool.price_change_pct,
    organic_score: pool.organic_score,
    holders: pool.holders,
    price_vs_ath_pct: pool.price_vs_ath_pct,
    smart_money_buy: pool.smart_money_buy ?? null,
    smart_money_confirmed: smartMoneyConfirmed,
    dev_sold_all: pool.dev_sold_all ?? null,
    risk_level: pool.risk_level ?? null,
    top10_pct: pool.top10_pct ?? null,
    dex_boost: pool.dex_boost ?? null,
    bin_step: pool.bin_step,
    tvl: pool.tvl,
    mcap: pool.mcap ?? null,
    tvl_mcap_ratio: tvlMcapRatio,
    tvl_per_holder: tvlPerHolder,
    fee_window: pool.fee_window,
    volume_window: pool.volume_window,
  }

  // Technique provenance (the third axis): which named, authored rule triggered this.
  // limit_order carries its indicator technique (bb_plus_rsi/ath_pullback); bid_ask/spot
  // enter via the router gate today. Shadow A/B (supertrend_or_rsi) is recorded, not gated.
  const primaryTechnique = score.technique || 'vol_feetvl_gate'
  const techAuthor = score.author || techniqueAuthor(primaryTechnique).author
  const provenance = {
    strategy: forceStrategy,
    condition_bucket: bucket,
    primary_technique: primaryTechnique,
    author: techAuthor,
    confirmations: [
      ...(pool.lo_indicator ? [{ technique: pool.lo_indicator.technique, author: pool.lo_indicator.author,
        confirmed: pool.lo_indicator.confirmed, reason: pool.lo_indicator.reason, skipped: pool.lo_indicator.skipped || false }] : []),
      ...(pool.entry_indicator ? [{ technique: pool.entry_indicator.technique, author: pool.entry_indicator.author,
        confirmed: pool.entry_indicator.confirmed, reason: pool.entry_indicator.reason, skipped: pool.entry_indicator.skipped || false }] : []),
    ],
    shadow: pool.lo_shadow ? {
      technique: pool.lo_shadow.technique, confirmed: pool.lo_shadow.confirmed,
      reason: pool.lo_shadow.reason, skipped: pool.lo_shadow.skipped || false,
    } : null,
    ...(exploration ? { exploration: true } : {}),
  }
  pool.entry_technique = primaryTechnique  // flows into the dry-run position record

  try {
    const result = recordDecision({
      created_at: new Date().toISOString(),
      expires_at: expiresAt,
      token_mint: pool.base?.mint,
      token_symbol: pool.base?.symbol,
      pool_address: pool.pool,
      strategy: forceStrategy,
      indicators_json: JSON.stringify(indicators),
      strategy_scores_json: JSON.stringify(allScores),
      llm_verdict: null,
      confidence,
      condition_bucket: bucket,
      primary_technique: primaryTechnique,
      technique_author: techAuthor,
      signal_provenance_json: JSON.stringify(provenance),
      confidence_trace_json: JSON.stringify(trace),
    })

    const decisionId = result.lastInsertRowid

    // Open a dry run position immediately so we start tracking P&L
    try {
      dryRun.openForDecision(decisionId, pool, forceStrategy)
    } catch (drErr) {
      console.error(`[IC] Failed to open dry run for decision #${decisionId}:`, drErr.message)
    }

    // Telegram alert — fire-and-forget. Include entry parameters for manual execution
    // (single-sided SOL bid BELOW price): entry price + the downward range it covers.
    const _rangePct = dryRun.rangePctForStrategy(forceStrategy, pool.bin_step)
    telegram.recommendation({
      token:      pool.base?.symbol || '?',
      strategy:   forceStrategy,
      confidence: Math.round(confidence * 100),
      ttlMinutes,
      verdict:    null,
      poolUrl:    pool.pool ? `https://app.meteora.ag/dlmm/${pool.pool}` : null,
      entryPrice: pool.price ?? null,
      rangePct:   _rangePct ?? null,
      rangeLow:   (pool.price != null && _rangePct != null) ? pool.price * (1 - _rangePct) : null,
    }).catch(e => console.warn('[IC] Telegram alert failed:', e.message))

    // Fire-and-forget LLM verdict (only if AI enabled in config)
    if (cfg.ai?.enabled) {
      generateVerdict(decisionId, pool, forceStrategy, bucket, indicators, cfg.ai)
    }

    // Meridian integration — push signal via webhook (fire-and-forget)
    if (cfg.meridian?.enabled && cfg.meridian?.webhookUrl) {
      const meridian = require('../meridian/index')
      meridian.pushRecommendation({
        decision_id:          decisionId,
        token_symbol:         pool.base?.symbol,
        token_mint:           pool.base?.mint,
        pool_address:         pool.pool,
        strategy:             forceStrategy,
        confidence:           confidence,
        expires_at:           expiresAt,
        condition_bucket:     bucket,
        smart_money_confirmed: smartMoneyConfirmed,
        pool_url:             `https://app.meteora.ag/dlmm/${pool.pool}`,
      }).catch(() => {})
    }

    const patStr = pattern?.active ? ` [hist ${(pattern.win_rate*100).toFixed(0)}%/${pattern.sample_count}]` : ''
    console.log(`[IC] #${decisionId} ${pool.base?.symbol} → ${forceStrategy} (conf=${(confidence*100).toFixed(0)}, ttl=${ttlMinutes}m${patStr})`)
    return { id: decisionId, pool, strategy: forceStrategy, score: score.score, ttlMinutes, expiresAt, bucket }
  } catch (e) {
    console.error(`[IC] Failed to record decision for ${pool.base?.symbol}:`, e.message)
    return null
  }
}

/**
 * Score an ARBITRARY pool on demand — read-only, NO writes (no decision, no dry-run, no Telegram).
 * The bridge that lets Meridian get Argus's verdict on ITS OWN picks (which Argus never independently
 * screened), so the Argus→Meridian loop can close (shadow-follow then confidence-gated execution).
 *
 * Reuses the SAME shared scoring/gate/modifier functions as processPool — only the orchestration is
 * duplicated (read-only). KEEP THE CONFIDENCE-BUILD SEQUENCE IN SYNC WITH processPool: base score →
 * pattern adjust → smart-money → entry-indicator → liquidity → age. Indicator enrichment is skipped
 * here (caller may pass pool.entry_indicator/lo_indicator if it has them).
 *
 * @param metrics  pool metrics Meridian already holds (volatility, fee_active_tvl_ratio, tvl, mcap,
 *                 holders, token_age_hours, bin_step, organic_score, price/volume_change_pct, ...)
 * @param strategy optional — if omitted, returns the best eligible strategy's verdict.
 */
function evaluatePool(metrics = {}, strategy = null) {
  const cfg = getConfig()
  // Map Meridian metrics onto the pool shape the scoring functions expect.
  const pool = {
    pool: metrics.pool_address ?? metrics.pool ?? null,
    base: { mint: metrics.token_mint ?? metrics.mint ?? null, symbol: metrics.token_symbol ?? metrics.symbol ?? '?' },
    // Accept Meridian's buildArgusFeatures() field names as aliases so Meridian can send its
    // feature object verbatim (fee_tvl_ratio/entry_tvl/entry_mcap/entry_holders|holder_count).
    volatility:           metrics.volatility,
    fee_active_tvl_ratio: metrics.fee_active_tvl_ratio ?? metrics.fee_tvl_ratio,
    tvl:                  metrics.tvl   ?? metrics.entry_tvl,
    mcap:                 metrics.mcap  ?? metrics.entry_mcap,
    holders:              metrics.holders ?? metrics.entry_holders ?? metrics.holder_count,
    token_age_hours:      metrics.token_age_hours,
    bin_step: metrics.bin_step, organic_score: metrics.organic_score,
    price_change_pct: metrics.price_change_pct, volume_change_pct: metrics.volume_change_pct,
    price_vs_ath_pct: metrics.price_vs_ath_pct, dev_sold_all: metrics.dev_sold_all,
    volume_trend: metrics.volume_trend, entry_phase: metrics.entry_phase,
    lo_indicator: metrics.lo_indicator ?? null, entry_indicator: metrics.entry_indicator ?? null,
  }

  const tokenGate = riskState.check(pool.base.mint)
  if (!tokenGate.allowed) return { recommended: false, blocked: true, reason: `token blocked: ${tokenGate.reason}` }

  const allScores = scoreStrategies(pool, cfg)
  const bucket = conditionBucket(pool)
  const { volatility_bucket, fee_bucket, regime, age_bucket } = parseBucket(bucket)
  const gateCfg = cfg.learning?.confidenceGate ?? {}
  const gateEnabled = gateCfg.enabled !== false

  // Pick the strategy to assess: caller's, else the best ELIGIBLE one.
  let chosen = strategy ? allScores.find(s => s.strategy === strategy)
                        : allScores.filter(s => s.eligible).sort((a, b) => b.score - a.score)[0]
  if (!chosen || !chosen.eligible) {
    return { recommended: false, blocked: false, strategy: chosen?.strategy ?? strategy,
      reason: chosen?.reason || 'no eligible strategy', bucket, strategy_scores: allScores }
  }
  const strat = chosen.strategy

  const pat = getPattern(volatility_bucket, regime, strat, fee_bucket, age_bucket)
  const adj = adjustScore(chosen.score, pat, cfg, strat)
  const gate = gateEnabled ? checkPatternGate(pat, adj, gateCfg) : { blocked: false }

  // Confidence build — same sequence as processPool, read-only.
  let confidence = adj
  const trace = [{ step: 'base_score', value: round3(chosen.score), detail: `${strat} rule score` }]
  if (pat) trace.push({ step: 'pattern_adjust', value: round3(adj), factor: null,
    detail: pat.active ? `${volatility_bucket}×${regime}×${strat} active WR ${(pat.win_rate*100||0).toFixed(0)}% N=${pat.sample_count} (${pat.source||'sim'})`
                       : `pattern calibrating (N=${pat.sample_count||0})` })

  let smartMoney = false
  try {
    const smRow = pool.pool ? db.prepare(`SELECT COUNT(DISTINCT wallet_address) cnt FROM wallet_actions
      WHERE pool_address = ? AND wallet_type='smart_money' AND detected_at > datetime('now','-24 hours')
        AND action_type IN ('add_liquidity','open_position')`).get(pool.pool) : { cnt: 0 }
    if ((smRow?.cnt || 0) > 0) { smartMoney = true; confidence = Math.min(1, confidence * 1.15)
      trace.push({ step: 'smart_money', value: round3(confidence), factor: 1.15, detail: `${smRow.cnt} smart wallet(s)` }) }
  } catch {}

  if (pool.entry_indicator && !pool.entry_indicator.skipped && pool.entry_indicator.confirmed) {
    confidence = Math.min(1, confidence * 1.10)
    trace.push({ step: 'entry_indicator', value: round3(confidence), factor: 1.10, detail: `${pool.entry_indicator.technique} confirmed` })
  }
  const liqMod = liquidityModifier(pool, cfg)
  if (liqMod.factor < 1) { confidence *= liqMod.factor
    trace.push({ step: 'liquidity_penalty', value: round3(confidence), factor: round3(liqMod.factor), detail: liqMod.note }) }
  const ageMod = ageModifier(pool, cfg)
  if (ageMod.factor < 1) { confidence *= ageMod.factor
    trace.push({ step: 'age_penalty', value: round3(confidence), factor: round3(ageMod.factor), detail: ageMod.note }) }
  trace.push({ step: 'final', value: round3(confidence), detail: gate.blocked ? `gate would block: ${gate.reason}` : 'gate passed' })

  return {
    recommended: !gate.blocked,
    blocked: !!gate.blocked,
    strategy: strat,
    confidence: round3(confidence),
    raw_score: round3(chosen.score),
    condition_bucket: bucket,
    gate,
    smart_money_confirmed: smartMoney,
    technique: chosen.technique || 'vol_feetvl_gate',
    pattern: pat ? { active: !!pat.active, win_rate: pat.win_rate, sample_count: pat.sample_count, source: pat.source } : null,
    trace,
    strategy_scores: allScores,
    reason: gate.blocked ? gate.reason : 'eligible',
    source: 'argus',
  }
}

/**
 * Run a full screening + strategy routing cycle.
 * Called automatically by the scheduler every 15 minutes.
 * Runs one screening pipeline per configured profile (bid_ask, spot), each recording
 * only its own strategy so every strategy can accumulate learning samples.
 */
async function runScan() {
  if (_scanning) {
    console.log('[IC] Scan in progress — skipping duplicate trigger')
    return null
  }
  const started = Date.now()
  console.log('[IC] ── Scan started ──')

  try {
    _scanning = true
    // Synchronous risk gate — check before any network calls
    const gate = riskState.check()
    if (!gate.allowed) {
      console.log(`[IC] Scan blocked by risk gate: ${gate.reason}`)
      bus.emitSafe('risk_gate_blocked', { reason: gate.reason })
      return null
    }

    const cfg = getConfig()
    const limit = cfg.scan?.topCandidateLimit ?? 10
    const pipelines = cfg.scan?.pipelines ?? [
      { profile: 'bid_ask', strategy: 'bid_ask' },
      { profile: 'spot',    strategy: 'spot' },
    ]
    const quotaEnabled = cfg.scan?.explorationQuota?.enabled !== false

    const decisions = []
    let totalScreened = 0
    let totalCandidates = 0

    for (const pipe of pipelines) {
      const screening = resolveScreening(cfg, pipe.profile)
      let res
      try {
        res = await getTopCandidates({ limit, screening, pipeline: pipe.profile })
      } catch (e) {
        console.error(`[IC] Pipeline ${pipe.profile} screening failed:`, e.message)
        continue
      }
      totalScreened += res.total_screened || 0
      totalCandidates += res.candidates.length
      console.log(`[IC] Pipeline ${pipe.profile}→${pipe.strategy}: ${res.candidates.length} candidate(s)`)

      // Phase 3: gate limit_order on an indicator technique (bb_plus_rsi) + shadow A/B.
      // Parallel-fetch indicators only for the LO pipeline; failures fall back to the ATH gate.
      if (pipe.strategy === 'limit_order') {
        try { await enrichWithIndicators(res.candidates, cfg) }
        catch (e) { console.warn('[IC] indicator enrich failed:', e.message) }
      }
      // Phase 3+: soft entry indicator for spot (non-blocking — boosts confidence if confirmed).
      // bid_ask skipped: SOL bids benefit from overbought entries (price likely to fall toward bid).
      if (pipe.strategy === 'spot') {
        try { await enrichSpotIndicators(res.candidates, cfg) }
        catch (e) { console.warn('[IC] spot indicator enrich failed:', e.message) }
      }

      let pipeDecisions = 0
      for (const pool of res.candidates) {
        const dec = processPool(pool, cfg, pipe.strategy)
        if (dec) { decisions.push(dec); pipeDecisions++ }
      }

      // Exploration quota: if pattern gate blocked every candidate, force the top-scored
      // candidate through (bypassing active-pattern statistical checks) so every pipeline
      // always gathers at least one learning sample per scan.
      if (quotaEnabled && pipeDecisions === 0 && res.candidates.length > 0) {
        const dec = processPool(res.candidates[0], cfg, pipe.strategy, { exploration: true })
        if (dec) {
          decisions.push(dec)
          console.log(`[IC] Pipeline ${pipe.profile} exploration quota → decision #${dec.id}`)
        }
      }
    }

    const elapsed = Date.now() - started
    console.log(`[IC] ── Scan done in ${elapsed}ms: ${totalScreened} screened → ${totalCandidates} passed → ${decisions.length} decisions ──`)

    // Push results to frontend via WebSocket
    bus.emitSafe('ui_update', {
      type: 'scan_result',
      ts: new Date().toISOString(),
      total_screened: totalScreened,
      candidates: totalCandidates,
      decisions: decisions.length,
      elapsed_ms: elapsed,
    })

    return { decisions, total_screened: totalScreened, elapsed_ms: elapsed }
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

module.exports = { init, runScan, checkPatternGate, wilsonLowerBound, resolveScreening, evaluatePool }
