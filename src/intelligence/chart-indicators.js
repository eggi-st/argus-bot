'use strict'

/**
 * Chart-indicators client — Argus mirror of Meridian's tools/chart-indicators.js.
 *
 * Fetches OHLCV-derived indicators (RSI / Bollinger / Supertrend / Fibonacci) from the
 * shared agentMeridian endpoint and evaluates a named technique/preset. Used to gate
 * limit_order entry on a real dip-reversal signal instead of the data-starved ATH ratio.
 *
 * Pure evaluation (evaluatePreset) + a thin async fetch (graceful: any failure → skipped,
 * caller falls back to the ATH gate). See docs/TECHNIQUE-MAP-AND-PROVENANCE.md.
 */

const { getConfig } = require('../config')
const { techniqueAuthor } = require('./techniques')

function num(v) {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function buildSignalSummary(payload) {
  const latest = payload?.latest || {}
  const candle = latest.candle || {}
  const prev = latest.previousCandle || {}
  const bollinger = latest.bollinger || {}
  const supertrend = latest.supertrend || {}
  const fib = latest.fibonacci?.levels || {}
  return {
    close: num(candle.close),
    previousClose: num(prev.close),
    rsi: num(latest.rsi?.value),
    lowerBand: num(bollinger.lower),
    middleBand: num(bollinger.middle),
    upperBand: num(bollinger.upper),
    supertrendValue: num(supertrend.value),
    supertrendDirection: String(supertrend.direction || 'unknown'),
    supertrendBreakUp: !!latest.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest.states?.supertrendBreakDown,
    fib50: num(fib['0.500']),
    fib618: num(fib['0.618']),
    fib786: num(fib['0.786']),
  }
}

/**
 * Evaluate a preset for a given side. Pure. Returns { confirmed, reason, signal }.
 * Ported from Meridian (subset relevant to Argus strategies). oversold/overbought from config.
 */
function evaluatePreset(side, preset, payload) {
  const s = buildSignalSummary(payload)
  const icfg = getConfig().indicators || {}
  const oversold = Number(icfg.rsiOversold ?? 30)
  const overbought = Number(icfg.rsiOverbought ?? 80)
  const { close, previousClose, lowerBand, upperBand, rsi } = s
  const isBullish = s.supertrendDirection === 'bullish'
  const isBearish = s.supertrendDirection === 'bearish'
  const crossedUp = (lvl) => lvl != null && close != null && previousClose != null && previousClose < lvl && close >= lvl

  switch (preset) {
    case 'rsi_reversal':
      return side === 'entry'
        ? { confirmed: rsi != null && rsi <= oversold, reason: `RSI ${rsi ?? 'n/a'} <= oversold ${oversold}`, signal: s }
        : { confirmed: rsi != null && rsi >= overbought, reason: `RSI ${rsi ?? 'n/a'} >= overbought ${overbought}`, signal: s }
    case 'bollinger_reversion':
      return side === 'entry'
        ? { confirmed: close != null && lowerBand != null && close <= lowerBand, reason: `close ${close ?? 'n/a'} <= lowerBand ${lowerBand ?? 'n/a'}`, signal: s }
        : { confirmed: close != null && upperBand != null && close >= upperBand, reason: `close ${close ?? 'n/a'} >= upperBand ${upperBand ?? 'n/a'}`, signal: s }
    case 'bb_plus_rsi':
      return side === 'entry'
        ? { confirmed: close != null && lowerBand != null && close <= lowerBand && rsi != null && rsi <= oversold,
            reason: `close<=lowerBand (${close}<=${lowerBand}) & RSI ${rsi}<=${oversold}`, signal: s }
        : { confirmed: close != null && upperBand != null && close >= upperBand && rsi != null && rsi >= overbought,
            reason: `close>=upperBand & RSI>=${overbought}`, signal: s }
    case 'supertrend_or_rsi':
      return side === 'entry'
        ? { confirmed: s.supertrendBreakUp || (isBullish && close != null && s.supertrendValue != null && close >= s.supertrendValue) || (rsi != null && rsi <= oversold),
            reason: 'supertrend bullish or RSI oversold', signal: s }
        : { confirmed: s.supertrendBreakDown || (isBearish && close != null && s.supertrendValue != null && close <= s.supertrendValue) || (rsi != null && rsi >= overbought),
            reason: 'supertrend bearish or RSI overbought', signal: s }
    case 'rsi_plus_supertrend':
      return side === 'entry'
        ? { confirmed: (rsi != null && rsi <= oversold) && (s.supertrendBreakUp || isBullish), reason: 'RSI oversold with bullish supertrend', signal: s }
        : { confirmed: (rsi != null && rsi >= overbought) && (s.supertrendBreakDown || isBearish), reason: 'RSI overbought with bearish supertrend', signal: s }
    case 'supertrend_break':
      return side === 'entry'
        ? { confirmed: s.supertrendBreakUp || (isBullish && close != null && s.supertrendValue != null && close >= s.supertrendValue), reason: s.supertrendBreakUp ? 'flipped bullish' : 'above bullish supertrend', signal: s }
        : { confirmed: s.supertrendBreakDown || (isBearish && close != null && s.supertrendValue != null && close <= s.supertrendValue), reason: s.supertrendBreakDown ? 'flipped bearish' : 'below bearish supertrend', signal: s }
    case 'fibo_reclaim':
      return { confirmed: crossedUp(s.fib618) || crossedUp(s.fib50) || crossedUp(s.fib786), reason: 'reclaimed a key Fib level', signal: s }
    default:
      return { confirmed: false, reason: `unknown preset ${preset}`, signal: s }
  }
}

/** Strength score [0,1] for a confirmed entry — deeper oversold + further below band = stronger. */
function signalScore(signal) {
  const icfg = getConfig().indicators || {}
  const oversold = Number(icfg.rsiOversold ?? 30)
  const rsiScore = (signal.rsi != null) ? Math.max(0, Math.min(1, (oversold - signal.rsi) / oversold)) : 0.3
  const bandScore = (signal.close != null && signal.lowerBand > 0)
    ? Math.max(0, Math.min(1, (signal.lowerBand - signal.close) / signal.lowerBand))
    : 0.3
  return Math.round((0.6 + 0.4 * ((rsiScore + bandScore) / 2)) * 100) / 100
}

async function fetchChartIndicators(mint, { interval, candles, rsiLength, timeoutMs }) {
  const icfg = getConfig().indicators || {}
  const api = getConfig().api || {}
  const base = String(api.url || 'https://api.agentmeridian.xyz/api').replace(/\/+$/, '')
  const search = new URLSearchParams({
    interval: String(interval || '15_MINUTE'),
    candles: String(candles ?? icfg.candles ?? 298),
    rsiLength: String(rsiLength ?? icfg.rsiLength ?? 2),
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? icfg.perAttemptTimeoutMs ?? 8000)
  try {
    const res = await fetch(`${base}/chart-indicators/${mint}?${search}`, {
      headers: api.publicApiKey ? { 'x-api-key': api.publicApiKey } : {},
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`chart-indicators ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Confirm a technique (= preset) for a mint. Returns:
 *   { technique, author, confirmed, reason, signal, score, skipped }
 * skipped=true on any fetch failure → caller should fall back to its non-indicator gate.
 */
async function confirmTechnique(mint, technique, side = 'entry', interval = '15_MINUTE') {
  const { author } = techniqueAuthor(technique)
  if (!mint) return { technique, author, confirmed: false, skipped: true, reason: 'no mint' }
  try {
    const payload = await fetchChartIndicators(mint, { interval })
    const ev = evaluatePreset(side, technique, payload)
    return {
      technique, author,
      confirmed: !!ev.confirmed,
      reason: ev.reason,
      signal: ev.signal,
      score: ev.confirmed ? signalScore(ev.signal) : 0,
      skipped: false,
    }
  } catch (e) {
    return { technique, author, confirmed: false, skipped: true, reason: `indicators unavailable: ${e.message}` }
  }
}

/**
 * Enrich limit_order candidates with indicator confirmations (parallel).
 * Attaches pool.lo_indicator (primary preset) and pool.lo_shadow (shadow A/B preset).
 * No-op when indicators disabled. Failures leave pool.lo_indicator with skipped=true.
 */
async function enrichWithIndicators(candidates, cfg) {
  const icfg = cfg.indicators || {}
  if (!icfg.enabled || !Array.isArray(candidates) || !candidates.length) return
  const primaryPreset = icfg.limitOrderEntryPreset || 'bb_plus_rsi'
  const shadowPreset = icfg.limitOrderShadowPreset || 'supertrend_or_rsi'
  const interval = (Array.isArray(icfg.intervals) && icfg.intervals[0]) || '15_MINUTE'
  await Promise.allSettled(candidates.map(async (pool) => {
    const mint = pool.base?.mint
    if (!mint) return
    const [primary, shadow] = await Promise.all([
      confirmTechnique(mint, primaryPreset, 'entry', interval),
      shadowPreset && shadowPreset !== primaryPreset
        ? confirmTechnique(mint, shadowPreset, 'entry', interval)
        : Promise.resolve(null),
    ])
    pool.lo_indicator = primary
    pool.lo_shadow = shadow
  }))
}

module.exports = { evaluatePreset, signalScore, confirmTechnique, enrichWithIndicators, buildSignalSummary }
