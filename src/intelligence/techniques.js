'use strict'

/**
 * Technique registry — the third axis (alongside strategy + condition_bucket).
 *
 * A *technique* is a named, AUTHORED signal rule that says "now is a good moment".
 * Strategy = liquidity geometry (bid_ask/spot/limit_order). Technique = the trigger,
 * and crucially WHO authored it (provenance). See docs/TECHNIQUE-MAP-AND-PROVENANCE.md.
 *
 * This module is pure data + lookups (no DB) so schema.js can seed it without a cycle.
 *
 * author_type:
 *   classic_ta — public-domain indicator, wired by us/Meridian (RSI, Bollinger, …)
 *   community  — a named person's empirical pattern (bengshark), carries source_ref URL
 *   ai_derived — Argus discovered the edge itself (learned win-rates, LLM proposals)
 *   user       — eggi's own hand-tuned rule
 *
 * side:    entry | exit | both
 * maturity: live | battle_tested | dry_run | proposed | not_built
 * applies_to: strategies the technique is GOOD for (see the §5 mapping matrix)
 */

const CATALOGUE = [
  // ── argus-ai: already live in the router/learner ──────────────────────────
  {
    id: 'vol_feetvl_gate', label: 'Volatility + fee/TVL bands',
    author: 'argus-ai', author_type: 'ai_derived',
    attribution: 'Argus/Meridian router core, validated over 214 spot + 145 bid_ask closed positions (2026-06-20)',
    source_ref: 'argus/src/intelligence/strategy-router.js',
    side: 'entry', maturity: 'live', applies_to: ['bid_ask', 'spot'],
  },
  {
    id: 'pattern_edge', label: 'Learned win-rate (vol×regime×strategy)',
    author: 'argus-ai', author_type: 'ai_derived',
    attribution: 'Argus pattern_library conditional win-rates; modulates confidence once promoted',
    source_ref: 'argus/src/learning/pattern-reader.js',
    side: 'entry', maturity: 'live', applies_to: ['bid_ask', 'spot', 'limit_order'],
  },
  {
    id: 'smart_money', label: 'Tracked-wallet LP confirm',
    author: 'argus-ai', author_type: 'ai_derived',
    attribution: 'Hivemind smart-money wallets recently LP-d this pool → confidence boost',
    source_ref: 'argus/src/intelligence/index.js',
    side: 'entry', maturity: 'live', applies_to: ['bid_ask', 'spot', 'limit_order'],
  },

  // ── classic-ta: ported from Meridian chart-indicators (need OHLCV) ─────────
  {
    id: 'rsi_reversal', label: 'RSI ≤ oversold',
    author: 'classic-ta', author_type: 'classic_ta',
    attribution: 'Wilder RSI (1978); wired by Meridian chart-indicators',
    source_ref: 'meridian/tools/chart-indicators.js#rsi_reversal',
    side: 'both', maturity: 'battle_tested', applies_to: ['limit_order'],
  },
  {
    id: 'bollinger_reversion', label: 'Close ≤ lower band',
    author: 'classic-ta', author_type: 'classic_ta',
    attribution: 'Bollinger Bands (J. Bollinger, 1980s); wired by Meridian',
    source_ref: 'meridian/tools/chart-indicators.js#bollinger_reversion',
    side: 'both', maturity: 'battle_tested', applies_to: ['limit_order', 'spot'],
  },
  {
    id: 'bb_plus_rsi', label: 'Lower band AND RSI oversold',
    author: 'classic-ta', author_type: 'classic_ta',
    attribution: 'Bollinger + Wilder RSI combo; the sharpest dip-reversal confirmation',
    source_ref: 'meridian/tools/chart-indicators.js#bb_plus_rsi',
    side: 'entry', maturity: 'battle_tested', applies_to: ['limit_order'],
  },
  {
    id: 'supertrend_or_rsi', label: 'Supertrend bull OR RSI oversold',
    author: 'classic-ta', author_type: 'classic_ta',
    attribution: 'Supertrend (O. Seban) or Wilder RSI; Meridian live default entry',
    source_ref: 'meridian/tools/chart-indicators.js#supertrend_or_rsi',
    side: 'entry', maturity: 'battle_tested', applies_to: ['bid_ask'],
  },
  {
    id: 'rsi_plus_supertrend', label: 'RSI oversold AND bull trend',
    author: 'classic-ta', author_type: 'classic_ta',
    attribution: 'Reversal into an established uptrend',
    source_ref: 'meridian/tools/chart-indicators.js#rsi_plus_supertrend',
    side: 'entry', maturity: 'battle_tested', applies_to: ['bid_ask', 'limit_order'],
  },
  {
    id: 'supertrend_break', label: 'Supertrend flip',
    author: 'classic-ta', author_type: 'classic_ta',
    attribution: 'Supertrend (O. Seban); universal trend-break EXIT',
    source_ref: 'meridian/tools/chart-indicators.js#supertrend_break',
    side: 'exit', maturity: 'battle_tested', applies_to: ['bid_ask', 'spot', 'limit_order'],
  },
  {
    id: 'fibo_reclaim', label: 'Reclaim a key Fib level',
    author: 'classic-ta', author_type: 'classic_ta',
    attribution: 'Fibonacci retracement reclaim (.5/.618/.786)',
    source_ref: 'meridian/tools/chart-indicators.js#fibo_reclaim',
    side: 'both', maturity: 'battle_tested', applies_to: ['limit_order'],
  },
  {
    id: 'rsi_dump_entry', label: 'RSI-graded dump entry',
    author: 'classic-ta', author_type: 'classic_ta',
    attribution: 'Wilder RSI graded; pass-through unless pumping',
    source_ref: 'meridian/tools/chart-indicators.js#rsi_dump_entry',
    side: 'entry', maturity: 'battle_tested', applies_to: ['bid_ask', 'limit_order'],
  },

  // ── community: named, empirical, attributed to a person ────────────────────
  {
    id: 'bonus_stage', label: 'Fast Bid-Ask, Bonus Stage',
    author: 'bengshark', author_type: 'community',
    attribution: 'bengshark (@bengsharksol) empirical high-WR bid_ask pattern; front-test 6W/1L',
    source_ref: 'https://x.com/bengsharksol/status/2060220900428177743',
    side: 'entry', maturity: 'proposed', applies_to: ['bid_ask'],
  },

  // ── proposed: not yet in the indicator engine ─────────────────────────────
  {
    id: 'macd_cross', label: 'MACD bullish/bearish cross',
    author: 'classic-ta', author_type: 'classic_ta',
    attribution: 'MACD (G. Appel, 1979); NOT in the engine yet — proposal',
    source_ref: 'proposal',
    side: 'both', maturity: 'not_built', applies_to: ['limit_order'],
  },
]

const BY_ID = new Map(CATALOGUE.map(t => [t.id, t]))

/** Look up a technique by id (returns the catalogue object or null). */
function getTechnique(id) {
  return BY_ID.get(id) || null
}

/** Author + provenance for a technique id, for stamping onto decisions. */
function techniqueAuthor(id) {
  const t = BY_ID.get(id)
  return t ? { author: t.author, author_type: t.author_type } : { author: 'unknown', author_type: null }
}

/** Techniques good for a given strategy, optionally filtered by side. */
function techniquesForStrategy(strategy, side = null) {
  return CATALOGUE.filter(t =>
    Array.isArray(t.applies_to) && t.applies_to.includes(strategy) &&
    (side ? (t.side === side || t.side === 'both') : true)
  )
}

module.exports = { CATALOGUE, getTechnique, techniqueAuthor, techniquesForStrategy }
