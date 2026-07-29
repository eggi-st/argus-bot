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
    // Volatility data-gap recovery. The bulk pool-discovery page frequently returns
    // volatility=0 (no/stale data) for otherwise-qualified pools — historically the single
    // largest screening rejection ("unusable volatility (0)"). These pools already passed
    // mcap/holders/volume/tvl/fee gates, so losing them is lost opportunity, not a judgment.
    // When enabled, pools that come back with volatility<=0 get one targeted re-fetch against
    // the single-pool detail endpoint (same API, often fresher than the cached bulk page).
    // Adopts only a positive value; still subject to every downstream gate — admits nothing new.
    // Bounded per scan to cap extra API calls. Set enabled:false to restore the old behavior.
    volatilityRefetch: { enabled: true, maxPerScan: 40 },
    // Jupiter Token API v2 enrichment (lite-api.jup.ag, no-auth). Fills antirug/organic/holder/
    // age + token audit signal (mint/freeze authority, dev balance, top-holder concentration) by
    // mint — the same data OKX would provide but can't without a key, so the OKX-fed rug/honeypot
    // filter is currently dead. Fill-gaps only (never overwrites Meteora values); fail-safe. The
    // audit-derived rug flags are SHADOW (logged, not yet hard-rejected). Set false to disable.
    jupiterEnrich: true,
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
    // Silent-outage guard for the intake, mirroring wallet.healthMaxFailedCycles. Raise a
    // one-shot P1 after this many CONSECUTIVE scans where every pipeline came back with no
    // pool universe at all (screening call threw, or the API reported 0 matching pools).
    // A pipeline that screened a real universe and found nothing worth recommending is
    // healthy — that is a market condition and never counts here.
    //
    // 3 rather than the observer's 5 because the cadences differ: the observer polls every
    // 30s (5 cycles ~ 2.5 min) while the scan runs every 15 min, so 3 cycles is already a
    // 45-minute total blackout of the pool universe.
    healthMaxFailedCycles: 3,
  },
  learning: {
    // Pattern confidence gate — blocks (strategy × condition) combos with no proven edge.
    // Only applies once a pattern is ACTIVE (promoted at promotionThreshold samples).
    //
    // NOTE on minConfidence: this gates on PATTERN statistics, which are measured. The
    // confidence VALUE itself is a different matter — it does not predict real outcomes
    // (Spearman 0.083, p=0.41, n=102). Raising minConfidence to filter on "high confidence"
    // would be filtering on noise. See the warning in the `meridian` block below before
    // treating the confidence number as a quality signal anywhere.
    confidenceGate: {
      enabled: true,
      minWinRate: 0.35,      // require Wilson lower-bound of win_rate >= this
      minMeanPnl: -1.0,      // block if avg net P&L below this (%)
      minConfidence: 0.15,   // hard floor on blended confidence — a floor, NOT a quality bar
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
      saturationRatio: 0.80,  // ELIGIBILITY stream: reason must dominate this share of a
                              // per-strategy denominator (the one real gap hit 91.7%)
      // SCREENING stream needs its own, lower bar. Its denominator is ALL rejections, split
      // permanently across 5-6 competing reasons, so the largest share ever observed is ~50%
      // (volatility). At 0.80 this detector was unreachable — 0 fires in 123 rolling 24h
      // windows of real data. Simulated: 0.60 → 0 fires · 0.50 → 8 (6.5%) · 0.45 → 21 (17%)
      // · 0.35 → 98 (80%, noise) · 0.30 → 120 (98%, useless). 0.50 = one reason is an outright
      // majority of everything rejected, which is rare enough to be worth a look.
      screeningSaturationRatio: 0.50,
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
    ilStopPct: 8,         // fresh-stop when single-sided IL ≤ −this. Was 15 (loose): the entire
                          // dry-run loss tail came from 6 il_stop closes held ~70h that only fired
                          // at −20/−28%. Counterfactual over 148 closed sims: capping filled losses
                          // at −8% flips the whole book −0.41%→+1.18% (best of {8,10,12,15}); spot
                          // −0.82→+1.02, limit_order −4.15→−1.15, bid_ask untouched. Matches the
                          // live fresh-stop (8%) that was already validated positive (n=18).
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
  // Regime-risk OBSERVATORY. Tracks the (volatility × market-regime) → outcome map over a rolling
  // window and reports which cells carry a stable, tail-heavy negative edge worth sizing DOWN.
  // Validated 2026-07-21: the aggregate map separates, but per-cell EV FLIPS SIGN across time-thirds
  // at current sample sizes — the signal is noise until more data accrues. So this ships as pure
  // MONITORING: a cell only becomes 'brake_ready' after passing the stability gate for
  // graduateStreak consecutive recomputes. mode 'observatory' = advisory only (size_factor exposed
  // but never applied); switch to 'live' ONLY once cells graduate and a shadow period confirms it.
  regimeRisk: {
    mode:            'observatory',  // observatory (advisory-only) | live (Meridian honors size_factor)
    cron:            '0 */6 * * *',
    windowDays:      90,             // rolling window for the recompute
    minSamples:      25,             // a cell below this stays 'immature' (never actioned)
    tailRatePct:     4.0,            // require ≥ this %(pnl ≤ −8%) to count as tail-heavy
    graduateStreak:  3,             // consecutive passing recomputes before a cell is brake_ready
    brakeFactor:     0.5,            // advisory size multiplier for a brake_ready cell
  },
  scoring: {
    // Cross-strategy score normalisation. Each strategy in strategy-router.js scores on its own
    // invented scale — spot's `1 - vol/maxVol` PUNISHES volatility while bid_ask's `min(1, vol/3)`
    // REWARDS it — yet the results were compared against one shared threshold. Measured over 3656
    // decisions the distributions barely overlap (p50: spot 0.36, bid_ask 0.71, limit_order 0.76),
    // so Meridian's signalThreshold 0.65 was passing 67.8% of limit_order, 53.5% of bid_ask and
    // 5.1% of spot — a hidden strategy filter, and it favoured the WORST performers (spot wins
    // 62.1% in reality, bid_ask 55.8%, limit_order has never been executed at all).
    //
    // Mapping each score to its percentile within its own strategy's distribution makes "0.8"
    // mean the same thing everywhere. Simulated on the same 3656 decisions, 0.65 goes to
    // 34.0 / 34.4 / 26.9% — near-neutral, as a percentile scale should be.
    //
    // This does NOT make confidence predictive; see the warning in the `meridian` block. It
    // removes a systematic bias, it does not add information.
    normalize: {
      enabled:        true,
      windowDays:     30,   // rolling reference window — adapts as the market shifts
      minSamples:     50,   // below this a strategy passes through RAW (a percentile off a
                            // handful of points is noise, and cold starts must not be reshaped)
      refreshMinutes: 60,   // distribution cache TTL; rebuilding per pool would run ~90
                            // queries per scan for something that moves over days
    },
  },
  // DB retention. Only the pure-diagnostic tables are trimmed — the learning corpus
  // (decisions, dry_run_positions, feedback_outcomes, wallet_actions) is never pruned
  // because reconciliation and the regime observatory recompute over 90-day windows.
  retention: {
    enabled: true,
    cron:    '30 4 * * *',   // daily, offset from the 06:00 wallet-lifecycle job
    // screening_rejections is written ~2.8k rows/day (~900 KB/day) and read only over a
    // 24h self-diagnosis window. 30 days leaves ample slack for dashboard drill-downs.
    screeningRejectionsDays: 30,
    // gate_queries grows with how often Meridian polls, not with anything meaningful. Kept far
    // longer because a row with an outcome attached IS calibration data — only rows that never
    // got one are pruned.
    gateQueriesDays: 180,
    // 'incremental' (default) reclaims pages only if the DB was created with
    // auto_vacuum=INCREMENTAL; 'full' runs a real VACUUM (rewrites the whole file — slow,
    // needs 2× disk free). Set 'full' once manually to shrink an already-bloated file.
    vacuum: 'incremental',
  },
  // Portfolio-risk OBSERVATORY. Tracks whether outcomes move together AND whether enough
  // positions are open at once for that to matter. Both are required — perfectly correlated
  // outcomes across a one-position portfolio are just outcomes.
  //
  // Measured 2026-07-29 on 594 real outcomes, NEITHER holds yet:
  //   overdispersion 1.64x independent, p = 0.099 (permutation) → suggestive, not significant
  //   peak concurrency 4 ever; >=3 open only 0.5% of the time; median 1
  // So this ships as pure monitoring, exactly like regimeRisk. Do not switch mode to 'live'
  // until the gate has actually graduated.
  //
  // Event time comes from outcome_id (`pool:deployed_at`), never created_at — a bulk backfill
  // on 2026-06-26 landed 428 historical outcomes in one hour, which alone inflated measured
  // overdispersion from 1.6x to 5.2x and invented a phantom 428-position concurrency peak.
  portfolioRisk: {
    mode:       'observatory',  // observatory (advisory-only) | live | off
    cron:       '0 */6 * * *',
    windowDays: 90,
    // Gate — every condition must hold, then hold again for graduateStreak recomputes.
    minOutcomes:          200,   // below this the per-day loss rate is mostly noise
    minDays:              30,
    alpha:                0.05,  // permutation p-value threshold for real clustering
    minPeakConcurrency:   3,     // never seen above 4; if this never trips, portfolio risk is moot
    minPctTimeConcurrent: 5,     // and it has to be sustained, not a single spike (currently 0.5%)
    graduateStreak:       3,
    // Analysis knobs.
    minOutcomesPerDay: 4,        // days thinner than this are dropped from the variance estimate
    permutations:      5000,
    concurrencyLevel:  3,        // "concurrent" means at least this many open at once
    seed:              20260729, // fixed so an unchanged window yields an identical p-value —
                                 // a maturity streak must not advance on shuffle luck
    advisedMaxConcurrent: 2,     // only ever emitted once mature AND mode === 'live'
  },
  wallet: {
    // Set your Solana wallet address to enable observation — via WATCH_WALLET in .env
    // (preferred: keeps secrets out of user-config.json) or wallet.address in user-config.json.
    // Argus will poll for on-chain Meteora DLMM actions every pollIntervalMs ms.
    address: process.env.WATCH_WALLET || null,
    // Primary RPC. Prefer SOLANA_RPC_URL in .env (holds the Helius api-key secret) over
    // hardcoding it in user-config.json. Falls back to the public endpoint when unset.
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    // Fallback RPC endpoints used when the primary (rpcUrl, typically a rate-limited
    // Helius key) errors. The observer rotates through these so a single throttled key
    // no longer silently kills all wallet observation. Public endpoint is a safe last resort.
    rpcFallbackUrls: ['https://api.mainnet-beta.solana.com'],
    pollIntervalMs: 30_000,
    // Observer health: after this many CONSECUTIVE poll cycles where every RPC call errored
    // (not merely "no new activity"), raise a one-shot P1 alert. Guards against the silent
    // 3-week outage where a throttled Helius key stopped all observation unnoticed.
    healthMaxFailedCycles: 5,
    // Smart money wallets to track. Each entry: { address, label }
    // These wallets are observed as learning signals — their LP activity boosts
    // confidence when they enter the same pool Argus recommends.
    trackedWallets: [],
    // Hivemind discovery chain control.
    discovery: {
      // Sources never attempted. A disabled source gets no discovery_sources row and cannot
      // be revived from the Web UI — config wins over a resume click.
      //
      // Both entries below are off because they have no viable path to working without a paid
      // key. Neither ever contributed a wallet; both sat late in the priority chain burning a
      // retry every cycle. Removing them is purely subtractive — no discovery capability lost.
      //
      // 'okx' — needs okx.apiKey, which is not configured, so every daily retry failed
      // ("OKX API key not configured", 17 straight failures on the VPS as of 2026-07-28). The
      // rug/honeypot data it was meant to supply now comes from the no-auth Jupiter enrichment
      // in screener.js.
      // NOTE: this only disables OKX as a WALLET-DISCOVERY source. The separate OKX enrichment
      // path in intelligence/screener.js (enrichWithOkx) is unaffected and still runs keyless.
      //
      // 'solscan' — the host it calls, api.solscan.io, no longer resolves at all (DNS
      // NXDOMAIN, verified 2026-07-28); Solscan retired it. fetch() therefore rejects at the
      // network layer, before any HTTP status check, and the catch in solscan-source.js only
      // re-throws on 'rate limit'/'denied' — so all 5 tokens fall through to the generic
      // "Solscan returned no usable holder data", which misleadingly implies the API answered.
      // Successors need a paid key: pro-api.solscan.io/v2.0 → 401 "Token is missing";
      // public-api.solscan.io → 404.
      // BEFORE RE-ENABLING, solscan-source.js needs three fixes: (1) point at pro-api /v2.0 with
      // an auth header, (2) its token query is `SELECT DISTINCT … LIMIT 5` with no ORDER BY, so
      // DISTINCT's sort makes it always pick the 5 alphabetically-lowest mints — stale ones —
      // never the newest, (3) `created_at > datetime('now','-7 days')` compares ISO-with-T/Z
      // against SQLite's space-separated format; use julianday() on both sides.
      disabledSources: ['okx', 'solscan'],
    },
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
      // Anti-spiral floor: never let retirement drain the pool to zero. Keep the N
      // most-recently-seen wallets observable (state capped at 'stale') even past
      // retiredDays, so the observer can recover automatically once discovery/RPC heals
      // instead of dying permanently after one upstream outage.
      minActiveFloor: 3,
      // quality_score pairing window: a smart-money LP entry is credited with the FIRST
      // Argus dry-run position opened on the same pool within this many days after it.
      // 1 day matches the dry-run hold horizon (positions close in ~1–2h); widening it
      // starts crediting wallets for outcomes their entry could not have predicted.
      qualityWindowDays: 1,
    },
  },
  helius: {
    // Helius enhanced RPC — free tier at helius.xyz (100k credits/month).
    // Used by Hivemind Discovery for cleaner ADD_LIQUIDITY detection.
    // If set, becomes Source C in the fallback chain (after Meteora sources).
    // Prefer HELIUS_API_KEY in .env over user-config.json (keeps the secret out of a
    // file that's easy to cross-copy between machines).
    apiKey: process.env.HELIUS_API_KEY || null,
  },
  meridian: {
    // Meridian bot integration — feed Argus signals to Meridian for LP execution.
    // enabled: set true to activate webhook push on new recommendations.
    // webhookUrl: Meridian's incoming webhook endpoint (set in Meridian user-config.json).
    // argusUrl: public URL of this Argus instance — used by Meridian to poll signals.
    // smartWalletSync: if true, Meridian can import Argus smart wallets automatically.
    //
    // ⚠️ DO NOT set Meridian's `argus.blockOnLowConfidence: true`. Argus's confidence is
    // NOT calibrated against real outcomes, so gating on it would block trades on noise.
    // Measured 2026-07-28 on every real outcome linked back to a decision (n=102, all spot —
    // bid_ask and limit_order have ZERO linked real outcomes, so they are untestable):
    //
    //   Spearman confidence x pnl = 0.083 (p = 0.41, permutation)   → indistinguishable from 0
    //   Spearman confidence x win = -0.022
    //   win rate by confidence quartile: 68% / 64% / 70% / 64%      → no trend
    //
    // Meridian's default `argus.signalThreshold: 0.65` applied to those same 102 real trades
    // passes 3 and rejects 99 — it would veto 97% of Meridian's own book. (The 3 that pass
    // won, but n=3 proves nothing.) Confidence on actually-traded pools spans 0.15-0.70,
    // median 0.42; the 0.7-1.0 range is never traded at all, so it is entirely untested.
    //
    // Confidence DOES correlate with dry-run outcomes (rho 0.17-0.29 within strategy), but
    // that is circular: confidence and the simulated P&L are both functions of the same entry
    // metrics, and the pattern library that adjusts confidence is trained on those same dry
    // runs. It buys nothing against reality.
    //
    // Root cause is missing feedback, not a bad formula: ~88% of decisions never link to an
    // outcome, so almost nothing is available to calibrate against. Re-run this test before
    // trusting confidence as a gate — n=102 rules out a moderate relationship but not a weak
    // one (95% CI on rho is about [-0.11, +0.28]).
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
