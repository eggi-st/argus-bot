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
    // Per-strategy screening profiles. The base values above are the DEFAULT / bid_ask
    // profile (fresh high-vol memes). Each profile shallow-overrides the base so a dedicated
    // pipeline can target a different universe and let that strategy accumulate samples.
    profiles: {
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
    // Recommend LO when token has pulled back from ATH but isn't dead.
    maxPriceVsAthPct: 70,   // token must be ≤ 70% of ATH (some pullback)
    minPriceVsAthPct: 20,   // but not < 20% (potential dead token)
    maxVolatility: 2.0,      // low volatility preferred — stable base for LO entry
    minOrganic: 50,
    minHolders: 500,
    minTvl: 10_000,
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
  },
  learning: {
    // Pattern confidence gate — blocks (strategy × condition) combos with no proven edge.
    // Only applies once a pattern is ACTIVE (promoted at promotionThreshold samples).
    confidenceGate: {
      enabled: true,
      minWinRate: 0.35,     // require Wilson lower-bound of win_rate >= this
      minMeanPnl: -1.0,     // block if avg net P&L below this (%)
      minConfidence: 0.15,  // hard floor on blended confidence
      wilsonZ: 1.0,         // 1.0 ≈ one std-error lower bound; raise to 1.96 for stricter 95%
    },
    // Phase 3a — scoring blend. Confidence = rawScore blended with a shrinkage-damped,
    // EMA-weighted historical win rate; shrinks toward the per-strategy base rate (NOT 0.5)
    // so a high estimate on thin data barely moves the score.
    patternWeight: 0.30,       // weight of the historical term in the blend
    shrinkageK: 20,            // pseudo-count: p_score = N/(N+k)·ema + k/(N+k)·baseRate
    emaAlpha: 0.15,            // EMA update weight for recent outcomes (scoring only)
    baseRateFallback: 0.50,    // base rate used until baseRateMinSamples real outcomes exist
    baseRateMinSamples: 30,    // min closed outcomes before a strategy's own base rate is trusted
    // Phase 3a-ii — promotion + reconciliation.
    // 45: learning engages in a reasonable window; the deterministic gate + Wilson lower-bound
    // (which widens for small N and re-evaluates continuously) carry the ongoing statistical
    // discipline, so the promotion threshold need not be the full power-justified ~63.
    promotionThreshold: 45,
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
    autoTuner: {
      enabled: false,           // master switch — OFF until there is real per-strategy data
      mode: 'shadow',           // 'shadow' (propose only) | 'apply' (write, still gated)
      intervalCron: '0 */1 * * *',
      minSamplesPerStrategy: 50,  // SHADOW propose floor
      realSampleMin: 100,         // APPLY floor (per strategy)
      breakEvenWinRate: 0.50,
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
    // Close conditions
    stopLossPct: 20,      // close if price drops > 20% from entry
    takeProfitPct: 50,    // close if price rises > 50% from entry
    maxHoldMinutes: 240,  // close after 4 hours regardless
    // Fee simulation (net_pnl = price move + fee estimate − slippage).
    // CONSERVATIVE by design: fees are a capped estimate, NOT an IL-modeled LP return.
    simulateFees: true,
    maxSimulatedFeePct: 10,   // cap fee credit (pp) so extreme pool yields can't dominate
    inRangeFactor: 0.6,       // fraction of hold assumed in active range while earning fees
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
