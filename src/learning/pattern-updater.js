'use strict'
const bus = require('../core/event-bus')
const db  = require('../db/database')
const { getConfig } = require('../config')

/**
 * Parse conditionBucket string (e.g. "low_vol_medium_yield_neutral")
 * into the two dimensions used by pattern_library.
 */
function parseBucket(conditionBucket) {
  const parts = (conditionBucket || '').split('_')
  const VALID_VOL    = new Set(['low', 'medium', 'high'])
  const VALID_REGIME = new Set(['recovery', 'neutral', 'decline', 'froth'])
  return {
    volatility_bucket: VALID_VOL.has(parts[0])    ? parts[0]                : 'medium',
    regime:            VALID_REGIME.has(parts[parts.length - 1]) ? parts[parts.length - 1] : 'neutral',
  }
}

// Build the UPSERT SQL fresh per call so emaAlpha and promotionThreshold always reflect
// the current runtime config. better-sqlite3 caches by SQL string, so identical config
// between calls reuses the compiled statement. Called at most once per closed outcome event.
function buildUpsert(emaAlpha, promotionThreshold) {
  return `
  INSERT INTO pattern_library
    (updated_at, volatility_bucket, regime, strategy, win_rate, mean_pnl_net, sample_count, active, wins, ema_win_rate)
  VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
  ON CONFLICT(volatility_bucket, regime, strategy) DO UPDATE SET
    updated_at   = excluded.updated_at,
    win_rate     = ((win_rate * sample_count) + excluded.win_rate)     / (sample_count + 1),
    mean_pnl_net = ((mean_pnl_net * sample_count) + excluded.mean_pnl_net) / (sample_count + 1),
    sample_count = sample_count + 1,
    wins         = COALESCE(wins, 0) + excluded.wins,
    ema_win_rate = ${emaAlpha} * excluded.win_rate + (1 - ${emaAlpha}) * COALESCE(ema_win_rate, excluded.win_rate),
    active       = CASE WHEN sample_count + 1 >= ${promotionThreshold} THEN 1 ELSE active END
`
}

function resolveConditionBucket(positionId, source, conditionBucketOverride) {
  if (conditionBucketOverride) return conditionBucketOverride
  if (!positionId) return null
  if (source === 'meridian_feedback') {
    // positionId is decisions.id for Meridian-sourced outcomes
    const row = db.prepare(`SELECT condition_bucket FROM decisions WHERE id = ?`).get(positionId)
    return row?.condition_bucket ?? null
  }
  const row = db.prepare(`
    SELECT d.condition_bucket
    FROM dry_run_positions dr
    JOIN decisions d ON d.id = dr.decision_id
    WHERE dr.id = ?
  `).get(positionId)
  return row?.condition_bucket ?? null
}

function updatePattern(positionId, { netPnlPct, strategy, win, source, conditionBucketOverride }) {
  const bucket = resolveConditionBucket(positionId, source, conditionBucketOverride)
  if (!bucket) return
  if (!Number.isFinite(netPnlPct)) {
    console.warn('[Pattern] Invalid netPnlPct — skipping pattern update')
    return
  }

  const { volatility_bucket, regime } = parseBucket(bucket)
  const winVal = win ? 1.0 : 0.0
  const now    = new Date().toISOString()

  // Read config fresh so runtime changes to promotionThreshold / emaAlpha take effect
  // without restart. reconcile.js is the authoritative recompute; this is the fast cache.
  const L = getConfig().learning || {}
  const emaAlpha         = L.emaAlpha         ?? 0.15
  const promotionThreshold = L.promotionThreshold ?? 45

  db.prepare(buildUpsert(emaAlpha, promotionThreshold))
    .run(now, volatility_bucket, regime, strategy, winVal, netPnlPct, winVal, winVal)

  console.log(`[Pattern] ${volatility_bucket}×${regime}×${strategy}: win=${win ? '✓' : '✗'} pnl=${netPnlPct.toFixed(2)}%`)
}

function init() {
  bus.onSlow('outcome_recorded', payload => {
    if (!payload?.position_id && !payload?.condition_bucket) return
    try {
      updatePattern(payload.position_id, {
        netPnlPct:              payload.net_pnl_pct ?? 0,
        strategy:               payload.strategy,
        win:                    !!payload.win,
        source:                 payload.source,
        conditionBucketOverride: payload.condition_bucket ?? null,
      })
    } catch (e) {
      console.error('[Pattern] Update error:', e.message)
    }
  })
  console.log('[Pattern] Updater ready')
}

module.exports = { init, updatePattern, parseBucket }
