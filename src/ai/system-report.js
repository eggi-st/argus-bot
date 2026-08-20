'use strict'
// Phase 5 — system self-report. Assembles a STRUCTURED, read-only bundle (pattern stats +
// capability gaps + recent tuning events) and renders an honest status narration from a
// deterministic template. The optional LLM re-narration was removed in the Tier-A prune —
// it never ran once (ai.enabled false since it shipped), and the template is the source of truth.
// This module imports NO write path (no writeUserConfig / riskState / gate / recordDecision):
// it reads, writes a report row, and emits a UI event. Structurally cannot move money or config.
const db  = require('../db/database')
const bus = require('../core/event-bus')
const { getConfig } = require('../config')
const { recordSystemReport, listOpenGaps, getTuningEvents } = require('../db/schema')

const safe = (fn, fallback) => { try { return fn() } catch { return fallback } }

// Local Wilson lower bound (kept local to avoid a circular require on intelligence/index).
function wilson(p, n, z = 1.0) {
  if (!n || n <= 0) return 0
  const z2 = z * z
  return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n))
}

function buildReportBundle(cfg) {
  const L = cfg.learning || {}
  const threshold = L.promotionThreshold ?? 45
  const minWR = L.confidenceGate?.minWinRate ?? 0.35

  const totals = safe(() => db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM dry_run_positions WHERE status='closed' AND outcome_valid=1) AS closed,
      (SELECT COUNT(*) FROM dry_run_positions WHERE status='open') AS open_positions,
      (SELECT COUNT(*) FROM decisions WHERE status='active') AS active_decisions
  `).get(), {})

  const patterns = safe(() => db.prepare(`
    SELECT volatility_bucket, regime, strategy, win_rate, ema_win_rate, mean_pnl_net, sample_count, active
    FROM pattern_library ORDER BY sample_count DESC LIMIT 20
  `).all(), []).map(p => {
    const lb = wilson(p.win_rate ?? 0, p.sample_count ?? 0, 1.0)
    const gate_status = !p.active
      ? `calibrating (${p.sample_count}/${threshold})`
      : (lb < minWR ? 'gated (no proven edge)' : 'active')
    return {
      bucket: `${p.volatility_bucket}×${p.regime}×${p.strategy}`,
      n: p.sample_count, win_rate: p.win_rate, wilson_lb: Math.round(lb * 1000) / 1000,
      mean_pnl_net: p.mean_pnl_net, gate_status,
    }
  })

  const baseRates = safe(() => db.prepare(`
    SELECT strategy, COUNT(*) AS n, SUM(CASE WHEN net_pnl_pct>0 THEN 1 ELSE 0 END) AS wins, AVG(net_pnl_pct) AS mean
    FROM dry_run_positions WHERE status='closed' AND outcome_valid=1 GROUP BY strategy
  `).all(), [])

  const gaps = safe(() => listOpenGaps(), [])
  const tuning = safe(() => getTuningEvents(cfg.ai?.selfReport?.recentTuningLimit ?? 10), [])

  return {
    data_health: { cold_start: (totals.closed ?? 0) === 0, ...totals, promotion_threshold: threshold },
    base_rates: baseRates,
    patterns,
    capability_gaps: gaps.map(g => ({ kind: g.kind, strategy: g.strategy, reason: g.reason_key, severity: g.severity, saturation_pct: g.saturation_pct, action: g.suggested_action })),
    recent_tuning: tuning.map(t => ({ param: t.param_path, old: t.old_value, new: t.new_value, mode: t.mode, status: t.status, at: t.created_at })),
  }
}

function renderDeterministic(b) {
  const lines = ['🦅 Argus — status']
  if (b.data_health.cold_start) {
    lines.push(`No validated patterns yet (0 closed outcomes). Rule-based router only — learning is calibrating.`)
  } else {
    lines.push(`Outcomes: ${b.data_health.closed} closed, ${b.data_health.open_positions} open, ${b.data_health.active_decisions} active rec.`)
    for (const r of b.base_rates) {
      const wr = r.n ? Math.round((r.wins / r.n) * 100) : 0
      lines.push(`• ${r.strategy}: ${wr}% win, avg ${(r.mean ?? 0).toFixed(2)}% net (N=${r.n})`)
    }
    const active = b.patterns.filter(p => p.gate_status === 'active')
    if (active.length) lines.push(`Active patterns: ${active.map(p => `${p.bucket} ${Math.round(p.win_rate * 100)}%/${p.n}`).join(', ')}`)
    else lines.push('No pattern has a statistically-proven edge yet (all calibrating or gated).')
  }
  if (b.capability_gaps.length) {
    lines.push('Capability gaps:')
    for (const g of b.capability_gaps) lines.push(`• [${g.severity}] ${g.strategy || '-'} ${g.reason} (${g.saturation_pct}%) — ${g.action}`)
  }
  if (b.recent_tuning.length) {
    lines.push('Recent tuning:')
    for (const t of b.recent_tuning.slice(0, 5)) lines.push(`• ${t.param}: ${t.old}→${t.new} [${t.mode}/${t.status}]`)
  }
  return lines.join('\n')
}

async function generateSystemReport() {
  const cfg = getConfig()
  if (cfg.ai?.selfReport?.enabled === false) return null
  const bundle = buildReportBundle(cfg)
  // Narration is deterministic-only. The guarded LLM path was removed in the Tier-A prune
  // (2026-08-20): ai.enabled and selfReport.useLlm had both been false since the feature
  // shipped, so every one of the 60 recorded reports was rendered by the template below.
  let text = renderDeterministic(bundle)
  const via = 'deterministic'
  const llm_fallback = 0
  const maxChars = cfg.ai?.selfReport?.maxReportChars ?? 1500
  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '…'

  try {
    recordSystemReport({ generated_at: new Date().toISOString(), via, llm_fallback, report_text: text, bundle_json: JSON.stringify(bundle) })
  } catch (e) { console.warn('[SelfReport] persist failed:', e.message) }

  bus.emitSafe('ui_update', { type: 'self_report_ready', via, ts: Date.now() })
  try { require('../notifications/telegram').systemReport(text) } catch {}
  console.log(`[SelfReport] generated (${via}${llm_fallback ? ', llm-fallback' : ''})`)
  return { text, via }
}

function init() {
  bus.onSlow('self_report_due', () => {
    generateSystemReport().catch(e => console.error('[SelfReport] error:', e.message))
  })
  console.log('[SelfReport] ready')
}

module.exports = { init, generateSystemReport, buildReportBundle, renderDeterministic }
