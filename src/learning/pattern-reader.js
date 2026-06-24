'use strict'
const db = require('../db/database')

function getPattern(volatilityBucket, regime, strategy) {
  return db.prepare(`
    SELECT win_rate, mean_pnl_net, sample_count, active
    FROM pattern_library
    WHERE volatility_bucket = ? AND regime = ? AND strategy = ?
    LIMIT 1
  `).get(volatilityBucket, regime, strategy)
}

/**
 * Blend rule-based score with historical win rate.
 * Pattern only influences confidence once active (N >= 20).
 * Blend: 70% rule-based + 30% historical.
 */
function adjustScore(rawScore, pattern) {
  if (!pattern?.active) return rawScore
  const winRate = pattern.win_rate ?? 0.5
  return Math.min(1, Math.max(0, rawScore * 0.7 + winRate * 0.3))
}

/**
 * One-line context string for LLM prompt: "Win 72%, avg +3.1% (N=47)"
 */
function getPatternContext(volatilityBucket, regime, strategy) {
  const p = getPattern(volatilityBucket, regime, strategy)
  if (!p || p.sample_count === 0) return 'No historical data yet'
  if (!p.active) return `Calibrating (N=${p.sample_count}/${20})`
  const wr  = (p.win_rate * 100).toFixed(0)
  const pnl = p.mean_pnl_net >= 0 ? `+${p.mean_pnl_net.toFixed(1)}` : p.mean_pnl_net.toFixed(1)
  return `Win ${wr}%, avg ${pnl}% (N=${p.sample_count})`
}

module.exports = { getPattern, adjustScore, getPatternContext }
