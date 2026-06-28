'use strict'
const EventEmitter = require('events')

// Fast path — UI and price-critical (<50ms SLA)
const FAST_EVENTS = new Set([
  'price_tick',             // Price update received
  'ui_update',              // Push data to web UI
  'alert_triggered',        // User-facing alert fired
  'scan_complete',          // Scan cycle finished
  'risk_gate_blocked',      // Recommendation blocked by RiskState
  'recommendation_expired', // TTL hit — verdict invalidated
  'heartbeat',              // Scheduler pulse
  'ttl_check',              // TTL check cycle
  'config_updated',         // user-config.json written at runtime (writeUserConfig)
])

// Slow path — AI and memory operations (1-10s SLA)
const SLOW_EVENTS = new Set([
  'ai_analysis_request',     // Token queued for LLM verdict
  'ai_analysis_complete',    // LLM returned verdict
  'memory_write',            // Write decision/outcome to SQLite
  'dry_run_update',          // Virtual position updated
  'pattern_update',          // Pattern library recalculation queued
  'wallet_action_detected',  // On-chain user action parsed
  'outcome_recorded',        // Dry run position closed with result
  'blacklist_updated',       // Token/deployer added to blacklist
  'tracked_wallets_updated', // Hivemind discovered new wallets
  'pattern_reconciliation',  // Recompute authoritative pattern stats from source
  'capability_diagnosis',    // Self-diagnosis aggregation cycle
  'capability_gap_detected', // A new capability gap was opened
  'self_report_due',         // Time to generate the consolidated status report
  'tuner_cycle',             // Auto-tuner evaluation tick
  'tuning_proposal',         // Auto-tuner proposed a bounded delta (shadow)
  'tuning_applied',          // Auto-tuner / operator applied a tuning delta
  'wallet_lifecycle_check',  // Daily wallet state-machine + quality scoring cycle
])

const ALL_EVENTS = new Set([...FAST_EVENTS, ...SLOW_EVENTS])

class ArgusEventBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(100)
  }

  emit(event, payload) {
    if (!ALL_EVENTS.has(event)) {
      console.warn(`[EventBus] Unknown event "${event}" — add to FAST_EVENTS or SLOW_EVENTS in event-bus.js`)
    }
    return super.emit(event, payload)
  }

  // Register listener guaranteed to be on the fast path
  onFast(event, listener) {
    if (!FAST_EVENTS.has(event)) throw new Error(`"${event}" is not a fast-path event`)
    return this.on(event, listener)
  }

  // Register listener on the slow path
  onSlow(event, listener) {
    if (!SLOW_EVENTS.has(event)) throw new Error(`"${event}" is not a slow-path event`)
    return this.on(event, listener)
  }

  // Emit without throwing — logs error from any listener instead of crashing
  emitSafe(event, payload) {
    try {
      this.emit(event, payload)
    } catch (err) {
      console.error(`[EventBus] Listener error on "${event}":`, err.message)
    }
  }

  get fastEvents() { return [...FAST_EVENTS] }
  get slowEvents() { return [...SLOW_EVENTS] }
}

module.exports = new ArgusEventBus()
