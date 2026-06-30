'use strict'
const fs = require('fs')
const path = require('path')

const USER_CONFIG_PATH = path.join(process.cwd(), 'user-config.json')

// These are Argus's core screening defaults — tuned conservatively.
// Override any value via user-config.json without touching this file.
const DEFAULTS = {
  screening: {
    // Market cap range — excludes micro-caps and large-caps
    minMcap: 50_000,
    maxMcap: 50_000_000,
    // Holder count — proxy for real distribution
    minHolders: 200,
    // Volume over the screening timeframe (USD)
    minVolume: 5_000,
    // TVL range (USD)
    minTvl: 5_000,
    maxTvl: null,
    // DLMM bin step range
    minBinStep: 20,
    maxBinStep: 200,
    // Fee/active-TVL ratio — core yield signal
    minFeeActiveTvlRatio: 0.01,
    // Organic score 0-100 (Jupiter/OKX). Base token / quote token.
    minOrganic: 30,
    minQuoteOrganic: 50,
    // Volatility cap (null = no cap)
    maxVolatility: 4.0,
    // Token age constraints (null = no constraint)
    minTokenAgeHours: null,
    maxTokenAgeHours: 72,
    // API params
    timeframe: '30m',
    category: 'all',
    excludeHighSupplyConcentration: true,
    // Anti-rug screen (attributed technique 'antirug_evilpanda', kind:'screen'). A universal
    // gate applied to ALL strategies. Thresholds learned from a 428-position forensic:
    // catastrophes (≤−5%) clustered at young age (~25h) + high TVL/mcap (~0.15) vs winners
    // (~175h, ~0.05). Rule lives in techniques.js SCREENS so live gating + counterfactual edge
    // share one source. Disable by setting enabled:false.
    antirug: {
      enabled: true,
      minTokenAgeHours: 48,    // forensic: winners p25=54h, catastrophes median 25h
      maxTvlMcapRatio: 0.10,   // forensic: catastrophes 0.15 vs winners 0.05 (exit-liquidity trap)
    },
    // Per-strategy screening profiles. The base values above are the DEFAULT / bid_ask
    // profile (fresh high-vol memes). Each profile shallow-overrides the base so a dedicated
    // pipeline can target a different universe and let that strategy accumulate samples.
    profiles: {
      bid_ask: {
        // High-vol meme universe. Base has maxTokenAgeHours:72 + antirug:minTokenAgeHours:48,
        // leaving only a 24h valid window (48–72h). Fix: widen upper cap to 2 weeks.
        // Valid window becomes 48h–336h. Base antirug (48h) is kept — no override needed.
        maxTokenAgeHours: 336,
      },
      spot: {
        // NOTE: maxVolatility is NOT set here — it derives from strategy.spotMaxVolatility
        // (single source of truth) via resolveScreening(), so one knob drives both the spot
        // screener cap and the spot router eligibility. Keeping a second copy here would let
        // them drift and would give the auto-tuner two incoherent gates to move.
        minTokenAgeHours: 24,    // older than the fresh-meme bid_ask universe
        maxTokenAgeHours: null,  // no upper age bound — let established calm pools through
      },
      limit_order: {
        // Established tokens that have had time to peak and pull back. Needs price_vs_ath_pct
        // (OKX maxPrice in prod, or Argus's internal ATH water mark as fallback) to qualify —
        // until that fills, this pipeline is a safe no-op surfaced by self-diagnosis.
        // maxVolatility derives from limitOrder.maxVolatility via resolveScreening (single source).
        minTokenAgeHours: 168,   // ≥7 days
        maxTokenAgeHours: null,
        minHolders: 500,
        minTvl: 10_000,
      },
    },
  },
  strategy: {
    // Spot LP is only deployed in the calm+moderate-yield zone.
    // Validated over 214 spot positions (84% win, worst −1.3%).
    spotMaxVolatility: 2,
    spotFeeTvlMin: 0.1,
    spotFeeTvlMax: 0.4,
  },
  limitOrder: {
    // Phase 3: limit_order eligibility is gated by an indicator technique (bb_plus_rsi)
    // when indicators.enabled, falling back to this ATH gate when OHLCV is unavailable.
    maxPriceVsAthPct: 70,   // token must be ≤ 70% of ATH (some pullback)
    minPriceVsAthPct: 20,   // but not < 20% (potential dead token)
    maxVolatility: 2.0,      // low volatility preferred — stable base for LO entry
    minOrganic: 50,
    minHolders: 500,
    minTvl: 10_000,
  },
  // agentMeridian shared API — OHLCV-derived chart indicators (read-only public key).
  api: {
    url: process.env.AGENT_MERIDIAN_URL || 'https://api.agentmeridian.xyz/api',
    publicApiKey: process.env.AGENT_MERIDIAN_KEY || 'bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz',
  },
  // Indicator-driven entry (Phase 3). Powers limit_order's bb_plus_rsi gate + supertrend_or_rsi
  // shadow A/B. Pure dip-confirmation matches the bid-below-price mechanic; see the design doc.
  indicators: {
    enabled: true,
    limitOrderEntryPreset: 'bb_plus_rsi',        // primary gate for limit_order
    limitOrderShadowPreset: 'supertrend_or_rsi', // shadow-recorded for A/B (does not gate)
    // Entry preset for spot pipeline (soft boost, not hard gate — unlike LO's bb_plus_rsi).
    // 'rsi_reversal' fires when RSI <= rsiOversold (entering at a local dip reduces IL risk).
    // Set to null to disable spot indicator enrichment.
    spotEntryPreset: 'rsi_reversal',
    // Exit preset used by the dry-run engine's indicator-based exit (Phase 3 exit wiring).
    // 'rsi_reversal' fires when RSI >= rsiOverbought — token extended, protecting accrued fees.
    // Alternatives: 'supertrend_break' (bearish flip), 'bollinger_reversion' (price >= upperBand),
    //               'rsi_plus_supertrend' (both confirmed), 'supertrend_or_rsi' (either).
    exitPreset: 'rsi_reversal',
    intervals: ['15_MINUTE'],
    candles: 298,
    rsiLength: 2,
    rsiOversold: 30,
    rsiOverbought: 80,
    perAttemptTimeoutMs: 8000,
  },
  scan: {
    topCandidateLimit: 10,
    // Each pipeline screens its own universe and records ONLY its strategy, so every strategy
    // can gather samples instead of bid_ask always winning a single global candidate pool.
    // limit_order is intentionally omitted: price_vs_ath_pct is null for fresh tokens (OKX has
    // no maxPrice), so it would find zero candidates until an ATH-data source is wired.
    pipelines: [
      { profile: 'bid_ask',     strategy: 'bid_ask' },
      { profile: 'spot',        strategy: 'spot' },
      { profile: 'limit_order', strategy: 'limit_order' },
    ],
    // Exploration quota: when every candidate in a pipeline is blocked by the active-pattern
    // gate, force the top candidate through (bypassing statistical gate, keeping confidence
    // floor). Guarantees at least 1 dry-run sample per pipeline per scan, preventing the
    // gate from starving new dimensions of data they need to get promoted.
    explorationQuota: { enabled: true },
  },
  wallet: {
    // Lifecycle state machine for tracked smart-money wallets.
    // Transitions are driven by last_seen staleness (updated by hivemind re-discovery
    // OR by a real on-chain wallet_action detected by the observer).
    //   active    → seen within coolingDays
    //   cooling   → inactive coolingDays–staleDays (still observed, grace period)
    //   stale     → inactive staleDays–retiredDays (still observed, low priority)
    //   retired   → inactive retiredDays+ (removed from observer, active=0)
    lifecycle: {
      coolingDays:  3,           // active → cooling after this many days without activity
      staleDays:    7,           // cooling → stale
      retiredDays:  14,          // stale → retired (ejected from observer)
      cron:         '0 6 * * *', // daily at 06:00 UTC
    },
  },
  learning: {
    // Pattern confidence gate — blocks (strategy × condition) combos with no proven edge.
    // Only applies once a pattern is ACTIVE (promoted at promotionThreshold samples).
    confidenceGate: {
      enabled: true,
      minWinRate: 0.35,      // require Wilson lower-bound of win_rate >= this
      minMeanPnl: -1.0,      // block if avg net P&L below this (%)
      minConfidence: 0.15,   // hard floor on blended confidence
      wilsonZ: 1.0,          // 1.0 ≈ one std-error lower bound; raise to 1.96 for stricter 95%
      // Payoff ratio gate: avg_win_pnl / |avg_loss_pnl| must be >= this.
      // Blocks patterns where losses dwarf wins even if win_rate looks acceptable.
      // 0.5 = lenient (avg win must be at least half the avg loss). Raise to 1.0 to require
      // break-even risk/reward, or 1.5 for a classic 1:1.5 minimum edge.
      minPayoffRatio: 0.5,
    },
    // Phase 3a — scoring blend. Confidence = rawScore blended with a shrinkage-damped,
    // EMA-weighted historical win rate; shrinks toward the per-strategy base rate (NOT 0.5)
    // so a high estimate on thin data barely moves the score.
    patternWeight: 0.30,       // weight of the historical term in the blend
    shrinkageK: 20,            // pseudo-count: p_score = N/(N+k)·ema + k/(N+k)·baseRate
    emaAlpha: 0.15,            // EMA update weight for recent outcomes (scoring only)
    baseRateFallback: 0.50,    // base rate used until baseRateMinSamples real outcomes exist
    baseRateMinSamples: 30,    // min closed outcomes before a strategy's own base rate is trusted
    // Liquidity-concentration confidence modifier. Soft penalty for pools that PASS the antirug
    // gate but sit in the riskier liquidity zone. RE-TUNED 2026-06-30 to REAL data (435 Meridian
    // closes via simulate-modifiers.js): winners cluster at tvl/mcap≈0.044 & tvl/holder≈6, while
    // catastrophes sit at tvl/mcap≈0.148 & tvl/holder≈26. The original sim-derived thresholds
    // (clean20/high40, mcap0.05/0.10) were ~3× too high → near-inert (discrimination 0.026).
    // Re-tuned values raise discrimination to 0.036 with only 4% winner over-penalty. Does NOT
    // loosen the hard antirug gate — gradient WITHIN the allowed zone only. enabled:false to disable.
    liquidityModifier: {
      enabled: true,
      tvlMcapClean: 0.045,       // tvl/mcap at/below this = no penalty (real winner median 0.044)
      tvlMcapGate: 0.08,         // max penalty by here (real catastrophes start ~0.077 = catas p25)
      tvlMcapMaxPenalty: 0.10,   // max confidence cut from the tvl/mcap term (×0.90)
      tvlPerHolderClean: 13,     // no penalty at/below (real winner p75 — keeps 75% of winners clean)
      tvlPerHolderHigh: 26,      // max penalty at/above (real catastrophe median)
      tvlPerHolderMaxPenalty: 0.12,
      floor: 0.80,               // never cut confidence below this multiple (cap total at −20%)
    },
    // Token-age confidence modifier (2026-06-30). On 435 REAL closes, token_age_hours was the
    // STRONGEST single predictor (AUC 0.846): catastrophe rate is concentrated below 72h (0-24h=15%,
    // 48-72h=10%) and ≈0% at 72h+. NOT linear "older=better" (win-rate flat past 72h) — it's a
    // catastrophe-zone DISCOUNT: full confidence at ≥safeAgeHours, ramping to a floor toward
    // youngAgeHours. Independent of mcap/holders (age~mcap corr 0.05) so it is NOT double-counting.
    // Backtest: 0% winner over-penalty, 28% of catastrophes discounted. Pairs with liquidityModifier
    // (combined discrimination 0.062). The hard antirug gate (minTokenAgeHours) stays the floor;
    // this softly down-weights the residual risky band (e.g. 48-72h) without rejecting its winners.
    ageModifier: {
      enabled: true,
      safeAgeHours: 72,          // at/above this = no penalty (real catastrophe rate ≈0 past 72h)
      youngAgeHours: 24,         // penalty maxes out at/below this (real 0-24h catastrophe rate 15%)
      maxPenalty: 0.12,          // max confidence cut for the youngest pools (×0.88)
    },
    // Smart-money confidence boost — DEFAULT OFF (2026-06-30). When a tracked smart wallet LP'd the
    // same pool in the last 24h, confidence was multiplied by `factor`. But on 95 boosted vs 175
    // non-boosted closes the boosted ones did NOT outperform (WR 82% vs 84%, mean +0.55% vs +0.71%) —
    // the auto-discovered (helius) wallets are not predictive alpha, so the boost was unearned and
    // mis-calibrated confidence that now flows to Meridian. Detection still runs (smart_money_confirmed
    // is recorded for analysis); only the multiplier is gated. Re-enable once wallets are PROVEN
    // predictive (e.g. quality_score-weighted, or hand-curated KOL wallets in wallet.trackedWallets).
    smartMoneyBoost: {
      enabled: false,
      factor: 1.15,
    },
    // Phase 3a-ii — promotion + reconciliation.
    // 45: learning engages in a reasonable window; the deterministic gate + Wilson lower-bound
    // (which widens for small N and re-evaluates continuously) carry the ongoing statistical
    // discipline, so the promotion threshold need not be the full power-justified ~63.
    promotionThreshold: 45,
    // STEP 1 reality-anchor: a (bucket×strategy) pattern uses REAL Meridian outcomes
    // (feedback_outcomes) once it has >= minRealSamples; below that it falls back to dry-run
    // SIM but is flagged source='sim' and treated as NEUTRAL by adjustScore (no confidence
    // boost) — because dry-run sim was proven optimistic (+5.5% vs reality −0.1%).
    minRealSamples: 20,
    reconcileEnabled: true,
    reconcileCron: '0 */6 * * *',
    // Phase 3b — deterministic self-diagnosis. Opens a capability_gaps row only when a reason
    // dominates a strategy's eligibility failures (or the screener) over a SUSTAINED window.
    diagnosis: {
      enabled: true,
      windowHours: 24,
      minDenominator: 30,     // need this many observations before judging
      minScans: 8,            // spread across this many distinct scans (anti false-positive)
      saturationRatio: 0.80,  // reason must dominate this share to count as a gap
      cron: '0 */6 * * *',
    },
    // Phase 4B — bounded auto-tuner. Ships OFF. Proposes damped, clamped deltas only when
    // reconciled per-strategy evidence is statistically significant. SHADOW = propose+log+notify
    // (no write); APPLY (write user-config) requires explicit opt-in + per-event human approval.
    // 2026-06-30 corrections (validated via preview-tuner.js on 435 real closes): the tuner now
    // (1) drives off REAL outcomes (feedback_outcomes) when a strategy has >= minSamplesPerStrategy,
    // falling back to SIM only below that; (2) refuses to WIDEN a strategy whose mean P&L < meanFloorForWiden
    // — real spot was 63% WR but −0.18% mean (fat loss tail), so WR-alone would wrongly widen a net loser.
    autoTuner: {
      enabled: false,           // master switch — OFF until there is real per-strategy data
      mode: 'shadow',           // 'shadow' (propose only) | 'apply' (write, still gated)
      intervalCron: '0 */1 * * *',
      minSamplesPerStrategy: 50,  // SHADOW propose floor + "trust REAL over SIM" threshold
      realSampleMin: 100,         // APPLY floor (per strategy)
      breakEvenWinRate: 0.50,
      meanFloorForWiden: 0,       // never WIDEN a strategy whose mean net P&L is below this (loss-tail guard)
      hysteresisBand: 0.05,       // Wilson bound must clear break-even by this margin
      wilsonZ: 1.96,              // stricter than the gate's 1.0
      maxStepsPerCycle: 1,
      cooldownSamples: 45,        // ≥ this many NEW closed positions before re-moving a param
      explorationQuota: 0,        // fraction of decisions forced from non-top pools (0 = off for now)
      // Tunable scalar whitelist. min = launch default = one-directional guard: the tuner can only
      // move a knob in the SAFE direction (widen spot vol from 2.0↑; make gate floors STRICTER only).
      // v1 acts on spotMaxVolatility only; gate-floor tuning is wired but deferred.
      params: {
        'strategy.spotMaxVolatility':         { min: 2.0,  max: 3.0,  step: 0.25 },
        'learning.confidenceGate.minWinRate': { min: 0.35, max: 0.50, step: 0.05 },
        'learning.confidenceGate.minMeanPnl': { min: -1.0, max: 0.0,  step: 0.25 },
      },
    },
  },
  dryRun: {
    // Virtual stake per position (SOL)
    solAmount: 0.1,
    // ── Phase 2 outcome-driven exits (single-sided-aware; act on computed P&L) ──
    // Hold is decoupled from the short recommendation TTL so a real exit can be observed.
    // TP aligned to the calibrated fee model: fees cap at 3% so net realistically tops out
    // ~+3%; a 5% target was unreachable → every position rode to max_hold ("time"). 2.5% lets
    // TP actually fire when fees accrue + price holds, so closes are faster & varied.
    netTargetPct: 2.5,    // take profit when net (gross + fee − slip) ≥ this
    ilStopPct: 15,        // stop loss when single-sided IL ≤ −this
    runUpExitPct: 30,     // price ran ≥ this above entry → SOL bid won't fill, reclaim capital
    maxHoldMinutes: 120,  // time-bound fallback (2h) — matches real Meridian hold times (median ~60-90m)
    // Fee simulation (net_pnl = single-sided P&L + fee estimate − fill-scaled slippage).
    // CONSERVATIVE by design: fees are a capped estimate, NOT an IL-modeled LP return.
    // CALIBRATED to reality (2026-06-27): the old cap=10 + no haircut gave dry-run
    // avg +5.47%/79% WR while Meridian's 428 REAL closes averaged −0.10%/60% WR — the
    // gap was almost entirely an over-generous fee credit. cap=3 + haircut=0.5 lands
    // dry-run at ~+0.3%/58%, in line with reality. Tune these to re-anchor as data grows.
    simulateFees: true,
    maxSimulatedFeePct: 3,    // cap fee credit (pp). Was 10 — single-sided LP rarely nets >3% in fees.
    feeCaptureHaircut: 0.5,   // fraction of the snapshot fee-rate actually captured over the hold
    inRangeFactor: 0.6,       // fraction of hold assumed in active range while earning fees
    // ── Trailing take-profit (Meridian-adapted) ───────────────────────────
    // Arms once net PnL reaches trailingTriggerPct; closes if it then drops trailingDropPct from peak.
    // Rationale: protects accrued fee gains before a price reversal converts them to IL.
    trailingTriggerPct: 3.0,  // arm at +3% net (achievable given fee cap of 3%)
    trailingDropPct: 1.5,     // close if peak drops ≥ 1.5pp
    // ── Indicator-based exit gate ─────────────────────────────────────────
    // When indicators.enabled + exitPreset set, chart signals supplement the hard exits.
    // Only checked after minHoldBeforeIndicatorCheck minutes to avoid early false positives.
    minHoldBeforeIndicatorCheck: 20,  // min hold before indicators are consulted (minutes)
  },
  wallet: {
    // Set your Solana wallet address in user-config.json to enable observation.
    // Argus will poll for on-chain Meteora DLMM actions every pollIntervalMs ms.
    address: null,
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    pollIntervalMs: 30_000,
    // Smart money wallets to track. Each entry: { address, label }
    // These wallets are observed as learning signals — their LP activity boosts
    // confidence when they enter the same pool Argus recommends.
    trackedWallets: [],
  },
  helius: {
    // Helius enhanced RPC — free tier at helius.xyz (100k credits/month).
    // Used by Hivemind Discovery for cleaner ADD_LIQUIDITY detection.
    // If set, becomes Source C in the fallback chain (after Meteora sources).
    apiKey: null,
  },
  meridian: {
    // Meridian bot integration — feed Argus signals to Meridian for LP execution.
    // enabled: set true to activate webhook push on new recommendations.
    // webhookUrl: Meridian's incoming webhook endpoint (set in Meridian user-config.json).
    // argusUrl: public URL of this Argus instance — used by Meridian to poll signals.
    // smartWalletSync: if true, Meridian can import Argus smart wallets automatically.
    enabled: false,
    webhookUrl: null,
    argusUrl: null,
    smartWalletSync: false,
  },
  ai: {
    // LLM verdict generation via OpenAI-compatible endpoint.
    // Compatible with SumoPod, Ollama (default), LM Studio, etc.
    // Set enabled: true in user-config.json to activate.
    enabled: false,
    sumopodUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'llama3',
    maxTokens: 100,
    timeoutMs: 20_000,
    // Phase 5 — self-report (narration of deterministic stats, NEVER a decision).
    selfReport: {
      enabled: true,
      useLlm: false,            // MVP is the deterministic template; flip only after a faithfulness eval
      digestCron: '0 9 * * *',  // one consolidated daily digest (09:00)
      maxReportChars: 1500,
      recentTuningLimit: 10,
      llmTemperature: 0,        // faithful summarization only
      llmMaxTokens: 400,
    },
  },
}

function deepMerge(base, override) {
  const result = { ...base }
  for (const [k, v] of Object.entries(override || {})) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = deepMerge(base[k] || {}, v)
    } else {
      result[k] = v
    }
  }
  return result
}

let _config = null

function getConfig() {
  if (_config) return _config
  let userConfig = {}
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf8'))
      console.log('[Config] user-config.json loaded')
    } catch (e) {
      console.warn('[Config] Cannot parse user-config.json:', e.message)
    }
  }
  _config = deepMerge(DEFAULTS, userConfig)
  return _config
}

function reloadConfig() {
  _config = null
  return getConfig()
}

/**
 * Find the DEFAULTS value at a dotted path (for type/scalar validation).
 */
function defaultAtPath(path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), DEFAULTS)
}

/**
 * Walk a patch object and warn on (a) type mismatch vs DEFAULTS and (b) array/object
 * leaves at a path where DEFAULTS holds a scalar. deepMerge replaces arrays wholesale,
 * so a tuner must only ever write SCALAR leaves — array paths are rejected (skipped).
 * Returns a sanitized copy with offending leaves removed.
 */
function validatePatch(patch, base = '') {
  const out = Array.isArray(patch) ? [] : {}
  for (const [k, v] of Object.entries(patch || {})) {
    const path = base ? `${base}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = validatePatch(v, path)
    } else {
      const def = defaultAtPath(path)
      if (Array.isArray(v) || Array.isArray(def)) {
        console.warn(`[Config] writeUserConfig: refusing array path "${path}" (deepMerge replaces arrays wholesale)`)
        continue
      }
      if (def !== undefined && typeof def !== typeof v) {
        console.warn(`[Config] writeUserConfig: type mismatch at "${path}" (default ${typeof def}, got ${typeof v}) — writing anyway`)
      }
      out[k] = v
    }
  }
  return out
}

/**
 * Atomically merge `patch` into the on-disk user-config.json (NOT the DEFAULTS-merged
 * runtime config — that would freeze current defaults into the user file), then invalidate
 * the cache so the next getConfig() (and the next scan) observe the change. This is the only
 * sanctioned runtime config writer; the auto-tuner uses it. Returns the merged user object.
 */
function writeUserConfig(patch) {
  const safe = validatePatch(patch)
  let onDisk = {}
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { onDisk = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf8')) } catch { onDisk = {} }
  }
  const merged = deepMerge(onDisk, safe)
  const tmp = USER_CONFIG_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8')
  fs.renameSync(tmp, USER_CONFIG_PATH)   // atomic replace — no partial file ever read
  reloadConfig()
  try { require('./core/event-bus').emitSafe('config_updated', { ts: Date.now(), paths: Object.keys(safe) }) } catch {}
  console.log('[Config] user-config.json updated:', JSON.stringify(safe))
  return merged
}

module.exports = { getConfig, reloadConfig, writeUserConfig, DEFAULTS }
