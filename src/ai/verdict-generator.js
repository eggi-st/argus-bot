'use strict'
const { callLLM }          = require('./llm-client')
const { getPatternContext } = require('../learning/pattern-reader')
const { parseBucket }       = require('../learning/pattern-updater')

function buildPrompt(pool, strategy, conditionBucket, indicators) {
  const { volatility_bucket, regime } = parseBucket(conditionBucket)
  const ctx = getPatternContext(volatility_bucket, regime, strategy)

  const vol    = indicators.volatility          != null ? indicators.volatility.toFixed(2)           : '?'
  const feeTvl = indicators.fee_active_tvl_ratio != null ? (indicators.fee_active_tvl_ratio * 100).toFixed(1) : '?'
  const ath    = indicators.price_vs_ath_pct     != null ? indicators.price_vs_ath_pct.toFixed(0)    : '?'
  const org    = indicators.organic_score        != null ? indicators.organic_score.toFixed(0)        : '?'
  const tvl    = indicators.tvl                  != null ? `$${(indicators.tvl / 1000).toFixed(0)}k`  : '?'

  return `Solana DLMM pool — ${strategy.toUpperCase()} strategy
Token: ${pool.base?.symbol || 'UNKNOWN'}
Regime: ${regime} | Volatility: ${vol} (${volatility_bucket}) | Fee/TVL: ${feeTvl}% | vs ATH: ${ath}%
Organic: ${org}/100 | TVL: ${tvl}
Historical: ${ctx}
In 1-2 sentences total: key opportunity and key risk.`
}

/**
 * Generate a narrative verdict for a pool candidate.
 * Fire-and-forget: updates decisions.llm_verdict in SQLite and emits ui_update.
 * This function always resolves — errors are silently logged.
 */
async function generateVerdict(decisionId, pool, strategy, conditionBucket, indicators, aiConfig) {
  try {
    const prompt  = buildPrompt(pool, strategy, conditionBucket, indicators)
    const verdict = await callLLM(prompt, aiConfig)

    const db = require('../db/database')
    db.prepare(`UPDATE decisions SET llm_verdict = ? WHERE id = ?`).run(verdict, decisionId)

    const bus = require('../core/event-bus')
    bus.emitSafe('ui_update', {
      type:         'verdict_ready',
      decision_id:  decisionId,
      verdict,
      token_symbol: pool.base?.symbol,
    })

    console.log(`[AI] #${decisionId} ${pool.base?.symbol}: ${verdict.slice(0, 60)}…`)
  } catch (e) {
    console.warn(`[AI] Verdict failed for #${decisionId}: ${e.message}`)
  }
}

module.exports = { generateVerdict, buildPrompt }
