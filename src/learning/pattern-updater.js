'use strict'
const bus = require('../core/event-bus')
const db  = require('../db/database')

const PROMOTION_THRESHOLD = 20  // samples required to activate a pattern

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

const UPSERT = `
  INSERT INTO pattern_library
    (updated_at, volatility_bucket, regime, strategy, win_rate, mean_pnl_net, sample_count, active)
  VALUES (?, ?, ?, ?, ?, ?, 1, 0)
  ON CONFLICT(volatility_bucket, regime, strategy) DO UPDATE SET
    updated_at   = excluded.updated_at,
    win_rate     = ((win_rate * sample_count) + excluded.win_rate)     / (sample_count + 1),
    mean_pnl_net = ((mean_pnl_net * sample_count) + excluded.mean_pnl_net) / (sample_count + 1),
    sample_count = sample_count + 1,
    active       = CASE WHEN sample_count + 1 >= ${PROMOTION_THRESHOLD} THEN 1 ELSE active END
`

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

  const { volatility_bucket, regime } = parseBucket(bucket)
  const winVal = win ? 1.0 : 0.0
  const now    = new Date().toISOString()

  db.prepare(UPSERT).run(now, volatility_bucket, regime, strategy, winVal, netPnlPct)

  if (!Number.isFinite(netPnlPct)) {
    console.warn('[Pattern] Invalid netPnlPct — skipping pattern update')
    return
  }
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
