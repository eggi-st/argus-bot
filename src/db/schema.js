'use strict'
const db = require('./database')

function initSchema() {
  db.transaction(() => {
  db.exec(`
    -- ── decisions ─────────────────────────────────────────────────────────────
    -- Every recommendation Argus makes — dry run or real.
    -- TTL enforced via expires_at. Status transitions: active → expired/followed/ignored
    CREATE TABLE IF NOT EXISTS decisions (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at           TEXT    NOT NULL,
      expires_at           TEXT    NOT NULL,
      token_mint           TEXT    NOT NULL,
      token_symbol         TEXT,
      pool_address         TEXT,
      strategy             TEXT    NOT NULL CHECK(strategy IN ('limit_order','spot','bid_ask')),
      indicators_json      TEXT,
      strategy_scores_json TEXT,
      llm_verdict          TEXT,
      confidence           REAL    DEFAULT 0,
      condition_bucket     TEXT,
      status               TEXT    DEFAULT 'active'
                                   CHECK(status IN ('active','expired','followed','ignored')),
      followed             INTEGER DEFAULT 0,
      outcome_pnl_pct      REAL,
      outcome_known        INTEGER DEFAULT 0,
      win                  INTEGER
    );

    -- ── dry_run_positions ──────────────────────────────────────────────────────
    -- Virtual positions for learning. pnl_net_usd includes slippage + tx_cost.
    -- Pattern Library only reads positions with status = 'closed' AND outcome_valid = 1
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id            INTEGER REFERENCES decisions(id),
      opened_at              TEXT    NOT NULL,
      closed_at              TEXT,
      token_mint             TEXT    NOT NULL,
      token_symbol           TEXT,
      pool_address           TEXT,
      strategy               TEXT    NOT NULL,
      entry_price_sol        REAL,
      exit_price_sol         REAL,
      entry_bin              INTEGER,
      range_bins             INTEGER,
      sol_amount             REAL,
      simulated_slippage_pct REAL    DEFAULT 0.3,
      tx_cost_usd            REAL    DEFAULT 0.002,
      gross_pnl_pct          REAL,
      net_pnl_pct            REAL,
      hold_minutes           INTEGER,
      outcome_valid          INTEGER DEFAULT 0,
      status                 TEXT    DEFAULT 'open'
                                     CHECK(status IN ('open','closed','expired'))
    );

    -- ── pattern_library ────────────────────────────────────────────────────────
    -- Conditional win-rate table: (volatility_bucket × regime × strategy)
    -- Only rows with active = 1 are read by Intelligence Core.
    -- Promotion from pending to active requires sample_count >= 20 (version gate).
    CREATE TABLE IF NOT EXISTS pattern_library (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      updated_at       TEXT    NOT NULL,
      volatility_bucket TEXT   NOT NULL CHECK(volatility_bucket IN ('low','medium','high')),
      regime           TEXT    NOT NULL CHECK(regime IN ('recovery','neutral','decline','froth')),
      strategy         TEXT    NOT NULL CHECK(strategy IN ('limit_order','spot','bid_ask')),
      win_rate         REAL,
      mean_pnl_net     REAL,
      sample_count     INTEGER DEFAULT 0,
      active           INTEGER DEFAULT 0,
      UNIQUE(volatility_bucket, regime, strategy)
    );

    -- ── wallet_actions ─────────────────────────────────────────────────────────
    -- On-chain user actions detected by Wallet Observer (Phase 3).
    -- match_category: 'followed' = matches an Argus recommendation,
    --                 'user_only' = independent user decision (counter-factual data)
    CREATE TABLE IF NOT EXISTS wallet_actions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at         TEXT    NOT NULL,
      signature           TEXT    UNIQUE,
      action_type         TEXT    CHECK(action_type IN (
                                    'open_position','close_position',
                                    'add_liquidity','remove_liquidity','claim_fees'
                                  )),
      pool_address        TEXT,
      token_mint          TEXT,
      token_symbol        TEXT,
      strategy            TEXT,
      amount_sol          REAL,
      matched_decision_id INTEGER REFERENCES decisions(id),
      match_category      TEXT    CHECK(match_category IN ('followed','user_only') OR match_category IS NULL)
    );

    -- ── blacklist ──────────────────────────────────────────────────────────────
    -- Tokens, pools, and deployers permanently excluded from recommendations.
    -- RiskState loads this at startup and keeps an in-memory copy for sync checks.
    CREATE TABLE IF NOT EXISTS blacklist (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      added_at  TEXT    NOT NULL,
      type      TEXT    NOT NULL CHECK(type IN ('token','pool','deployer')),
      value     TEXT    NOT NULL,
      reason    TEXT,
      UNIQUE(type, value)
    );

    -- ── Indexes ────────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_decisions_token   ON decisions(token_mint);
    CREATE INDEX IF NOT EXISTS idx_decisions_status  ON decisions(status);
    CREATE INDEX IF NOT EXISTS idx_decisions_expires ON decisions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_dry_run_status    ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_dry_run_decision  ON dry_run_positions(decision_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_detected   ON wallet_actions(detected_at);
    CREATE INDEX IF NOT EXISTS idx_pattern_active    ON pattern_library(active);
  `)

  db.exec(`
    -- ── tracked_wallets ────────────────────────────────────────────────────────
    -- Dynamic smart money wallets discovered by Hivemind Discovery system.
    -- Separate from user-config.json static list — auto-populated by sources.
    CREATE TABLE IF NOT EXISTS tracked_wallets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      discovered_at TEXT    NOT NULL,
      address       TEXT    UNIQUE NOT NULL,
      label         TEXT,
      source        TEXT    NOT NULL,
      active        INTEGER DEFAULT 1,
      pool_hits     INTEGER DEFAULT 1,
      last_seen     TEXT
    );

    -- ── discovery_sources ──────────────────────────────────────────────────────
    -- Per-source state machine: cooldown, failure tracking, pause.
    -- failure_count resets to 0 on success. cooldown doubles on each failure (max 24h).
    -- paused_until is set when failure_count >= 5 (auto-pause for 24h).
    CREATE TABLE IF NOT EXISTS discovery_sources (
      source        TEXT    PRIMARY KEY,
      last_run      TEXT,
      cooldown_ms   INTEGER DEFAULT 21600000,
      failure_count INTEGER DEFAULT 0,
      paused_until  TEXT,
      last_error    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tracked_wallets_active ON tracked_wallets(active);
  `)
  })()

  migrateSchema()
  console.log('[Schema] ✓ Database schema ready')
}

// ALTER TABLE migrations — safe to re-run (duplicate column errors are silently ignored)
function migrateSchema() {
  const cols = [
    // wallet_actions columns (original)
    `ALTER TABLE wallet_actions ADD COLUMN wallet_address TEXT`,
    `ALTER TABLE wallet_actions ADD COLUMN wallet_label TEXT`,
    `ALTER TABLE wallet_actions ADD COLUMN wallet_type TEXT DEFAULT 'own'`,
    // dry_run_positions — gap-fix columns (2026-06-25)
    `ALTER TABLE dry_run_positions ADD COLUMN entry_fee_rate REAL`,
    `ALTER TABLE dry_run_positions ADD COLUMN fee_window_minutes INTEGER`,
    `ALTER TABLE dry_run_positions ADD COLUMN close_reason TEXT`,
    `ALTER TABLE dry_run_positions ADD COLUMN exit_metrics_json TEXT`,
    `ALTER TABLE dry_run_positions ADD COLUMN simulated_fee_pct REAL`,
    // Single-sided SOL model (2026-06-26): downward price range the SOL liquidity covers
    // (range_bins × bin_step), used to compute dip-fill P&L instead of a symmetric token bet.
    `ALTER TABLE dry_run_positions ADD COLUMN range_pct REAL`,
    // Phase 3a (2026-06-26): EMA win-rate for scoring + cumulative wins for reconciliation.
    `ALTER TABLE pattern_library ADD COLUMN wins INTEGER DEFAULT 0`,
    `ALTER TABLE pattern_library ADD COLUMN ema_win_rate REAL`,
    `ALTER TABLE pattern_library ADD COLUMN last_reconciled_at TEXT`,
    // STEP 1 reality-anchor (2026-06-27): pattern_library can be backed by REAL Meridian
    // outcomes (feedback_outcomes) instead of only dry-run sim. source='real'|'sim';
    // live_* = real rollup, sim_* = dry-run rollup, reality_gap = live_wr − sim_wr.
    `ALTER TABLE pattern_library ADD COLUMN source TEXT`,
    `ALTER TABLE pattern_library ADD COLUMN live_win_rate REAL`,
    `ALTER TABLE pattern_library ADD COLUMN live_mean_pnl REAL`,
    `ALTER TABLE pattern_library ADD COLUMN live_sample_count INTEGER DEFAULT 0`,
    `ALTER TABLE pattern_library ADD COLUMN sim_win_rate REAL`,
    `ALTER TABLE pattern_library ADD COLUMN sim_sample_count INTEGER DEFAULT 0`,
    `ALTER TABLE pattern_library ADD COLUMN reality_gap REAL`,
    // Technique provenance (2026-06-26): the third axis — which technique/author triggered
    // this decision. Additive + nullable; see docs/TECHNIQUE-MAP-AND-PROVENANCE.md.
    `ALTER TABLE decisions ADD COLUMN primary_technique TEXT`,
    `ALTER TABLE decisions ADD COLUMN technique_author TEXT`,
    `ALTER TABLE decisions ADD COLUMN signal_provenance_json TEXT`,
    // Dry-run: record which technique opened/closed the position (replaces blind ttl_expired).
    `ALTER TABLE dry_run_positions ADD COLUMN entry_technique TEXT`,
    `ALTER TABLE dry_run_positions ADD COLUMN exit_technique TEXT`,
    // EV scoring (2026-06-29): track avg PnL split by wins vs losses — payoff ratio =
    // avg_win_pnl / |avg_loss_pnl|. Allows gate to block negative risk/reward patterns
    // even when win_rate looks acceptable. Computed by reconcile.js (authoritative path).
    `ALTER TABLE pattern_library ADD COLUMN avg_win_pnl REAL`,
    `ALTER TABLE pattern_library ADD COLUMN avg_loss_pnl REAL`,
  ]
  let added = 0
  for (const sql of cols) {
    try { db.exec(sql); added++ } catch (e) {
      if (!e.message?.includes('duplicate column name')) console.warn('[Schema] Migration:', e.message)
    }
  }

  // screening_rejections table — records every pool filtered out during a scan
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS screening_rejections (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        scanned_at   TEXT    NOT NULL,
        pool_address TEXT,
        token_symbol TEXT,
        token_mint   TEXT,
        reject_stage TEXT    NOT NULL,
        reason       TEXT    NOT NULL,
        key_metrics  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_rej_scanned ON screening_rejections(scanned_at);
    `)
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('[Schema] screening_rejections:', e.message)
  }

  // token_ath table — internal all-time-high water mark (fallback ATH when OKX has no maxPrice).
  // Builds from prices Argus already polls; only an ATH-since-we-started-watching, documented.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_ath (
        token_mint     TEXT PRIMARY KEY,
        ath_price_sol  REAL,
        ath_seen_at    TEXT,
        last_price_sol REAL,
        observations   INTEGER DEFAULT 0,
        first_seen_at  TEXT,
        updated_at     TEXT
      );
    `)
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('[Schema] token_ath:', e.message)
  }

  // capability_gaps table — self-diagnosis: sustained eligibility/screening blind spots
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS capability_gaps (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        signature         TEXT    NOT NULL UNIQUE,   -- kind|reason_key|strategy
        kind              TEXT    NOT NULL,          -- missing_indicator|universe_mismatch|threshold_saturation|data_quality
        reason_key        TEXT,
        strategy          TEXT,
        severity          TEXT,                      -- low|medium|high
        saturation_pct    REAL,
        denominator       INTEGER,
        sustained_scans   INTEGER,
        observation_count INTEGER,
        status            TEXT    DEFAULT 'open',     -- open|resolved|muted
        first_seen_at     TEXT,
        last_seen_at      TEXT,
        evidence_json     TEXT,
        suggested_action  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_capgap_status ON capability_gaps(status);
    `)
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('[Schema] capability_gaps:', e.message)
  }

  // system_reports table — Phase 5 self-report (deterministic or LLM-narrated status snapshots)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS system_reports (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        generated_at TEXT    NOT NULL,
        via          TEXT    CHECK(via IN ('deterministic','llm')),
        llm_fallback INTEGER DEFAULT 0,
        report_text  TEXT,
        bundle_json  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sysreport_gen ON system_reports(generated_at);
    `)
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('[Schema] system_reports:', e.message)
  }

  // tuning_events table — Phase 4B auto-tuner audit (proposals/applies/reverts)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tuning_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at      TEXT    NOT NULL,
        param_path      TEXT    NOT NULL,
        old_value       REAL,
        new_value       REAL,
        delta           REAL,
        strategy        TEXT,
        reason          TEXT,
        sample_count    INTEGER,
        win_rate        REAL,
        wilson_lb       REAL,
        mean_pnl_net    REAL,
        metric_confidence TEXT,
        mode            TEXT CHECK(mode IN ('shadow','apply')),
        status          TEXT CHECK(status IN ('proposed','applied','reverted','rejected')),
        reverted_from   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_tuning_created ON tuning_events(created_at);
    `)
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('[Schema] tuning_events:', e.message)
  }

  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_type ON wallet_actions(wallet_type, detected_at)`)
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('[Schema] Index migration:', e.message)
  }
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_sig ON wallet_actions(signature) WHERE signature IS NOT NULL`)
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('[Schema] Sig index migration:', e.message)
  }
  if (added) console.log(`[Schema] Added ${added} column(s) via migration`)

  // techniques registry — the third axis (provenance). Seeded from the static catalogue.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS techniques (
        id            TEXT PRIMARY KEY,
        label         TEXT NOT NULL,
        author        TEXT NOT NULL,
        author_type   TEXT NOT NULL CHECK(author_type IN ('classic_ta','community','ai_derived','user')),
        attribution   TEXT,
        source_ref    TEXT,
        side          TEXT CHECK(side IN ('entry','exit','both')),
        kind          TEXT DEFAULT 'timing',  -- 'timing' (entry/exit signals) | 'screen' (universe gates)
        applies_to    TEXT,
        maturity      TEXT DEFAULT 'proposed',
        version       INTEGER DEFAULT 1,
        created_at    TEXT NOT NULL
      );
    `)
    try { db.exec(`ALTER TABLE techniques ADD COLUMN kind TEXT DEFAULT 'timing'`) } catch {}
    seedTechniques()
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('[Schema] techniques:', e.message)
  }

  // feedback_outcomes (Phase 5) — real Meridian execution outcomes, the LIVE ground-truth
  // counterpart to dry_run_positions. Kept separate so the attribution rollup can compare
  // dry-run vs live per technique (the reality-gap signal). Deduped on outcome_id.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_outcomes (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at        TEXT NOT NULL,
        outcome_id        TEXT,                 -- stable per close (pool:deployed_at) for dedup
        source            TEXT,                 -- 'meridian'
        pool_address      TEXT,
        token_symbol      TEXT,
        strategy          TEXT,
        entry_technique   TEXT,
        technique_author  TEXT,
        exit_technique    TEXT,
        pnl_pct           REAL,
        fees_earned_usd   REAL,
        win               INTEGER,
        minutes_held      INTEGER,
        close_reason      TEXT,
        condition_bucket  TEXT,
        linked_decision_id INTEGER,
        features_json     TEXT                  -- full rich feature set per position (Meridian)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_outcome_id ON feedback_outcomes(outcome_id) WHERE outcome_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_feedback_tech ON feedback_outcomes(entry_technique, strategy);
    `)
    // Existing dbs (VPS): add the rich-features column if missing (fresh dbs already have it).
    try { db.exec(`ALTER TABLE feedback_outcomes ADD COLUMN features_json TEXT`) } catch {}
  } catch (e) {
    if (!e.message?.includes('already exists')) console.warn('[Schema] feedback_outcomes:', e.message)
  }
}

// Seed/refresh the technique registry from the static catalogue. INSERT OR REPLACE so
// catalogue edits (label, attribution, applies_to) propagate on restart without losing rows.
function seedTechniques() {
  const { CATALOGUE } = require('../intelligence/techniques')
  const now = new Date().toISOString()
  const stmt = db.prepare(`
    INSERT INTO techniques (id, label, author, author_type, attribution, source_ref, side, kind, applies_to, maturity, version, created_at)
    VALUES (@id, @label, @author, @author_type, @attribution, @source_ref, @side, @kind, @applies_to, @maturity, @version, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      label=excluded.label, author=excluded.author, author_type=excluded.author_type,
      attribution=excluded.attribution, source_ref=excluded.source_ref, side=excluded.side,
      kind=excluded.kind, applies_to=excluded.applies_to, maturity=excluded.maturity, version=excluded.version
  `)
  const tx = db.transaction(rows => {
    for (const t of rows) {
      stmt.run({
        id: t.id, label: t.label, author: t.author, author_type: t.author_type,
        attribution: t.attribution ?? null, source_ref: t.source_ref ?? null,
        side: t.side ?? null, kind: t.kind === 'screen' ? 'screen' : 'timing',
        applies_to: JSON.stringify(t.applies_to ?? []),
        maturity: t.maturity ?? 'proposed', version: t.version ?? 1, created_at: now,
      })
    }
  })
  tx(CATALOGUE)
  console.log(`[Schema] Seeded ${CATALOGUE.length} technique(s)`)
}

// ── Command Queue helpers ─────────────────────────────────────────────────────
// All writes go through these helpers to ensure serialization.
// Callers emit a 'memory_write' event; this module executes atomically.

const stmts = {}

function getStmt(key, sql) {
  if (!stmts[key]) stmts[key] = db.prepare(sql)
  return stmts[key]
}

function recordDecision(data) {
  return getStmt('insertDecision', `
    INSERT INTO decisions
      (created_at, expires_at, token_mint, token_symbol, pool_address, strategy,
       indicators_json, strategy_scores_json, llm_verdict, confidence, condition_bucket,
       primary_technique, technique_author, signal_provenance_json)
    VALUES
      (@created_at, @expires_at, @token_mint, @token_symbol, @pool_address, @strategy,
       @indicators_json, @strategy_scores_json, @llm_verdict, @confidence, @condition_bucket,
       @primary_technique, @technique_author, @signal_provenance_json)
  `).run(data)
}

function expireDecision(id) {
  return getStmt('expireDecision', `UPDATE decisions SET status = 'expired' WHERE id = ?`).run(id)
}

function markFollowed(id) {
  return getStmt('markFollowed', `UPDATE decisions SET status = 'followed', followed = 1 WHERE id = ?`).run(id)
}

function recordDryRunPosition(data) {
  return getStmt('insertDryRun', `
    INSERT INTO dry_run_positions
      (decision_id, opened_at, token_mint, token_symbol, pool_address, strategy,
       entry_price_sol, entry_bin, range_bins, sol_amount, simulated_slippage_pct, tx_cost_usd,
       entry_fee_rate, fee_window_minutes, range_pct, entry_technique)
    VALUES
      (@decision_id, @opened_at, @token_mint, @token_symbol, @pool_address, @strategy,
       @entry_price_sol, @entry_bin, @range_bins, @sol_amount, @simulated_slippage_pct, @tx_cost_usd,
       @entry_fee_rate, @fee_window_minutes, @range_pct, @entry_technique)
  `).run(data)
}

function closeDryRunPosition(id, data) {
  return getStmt('closeDryRun', `
    UPDATE dry_run_positions
    SET closed_at          = @closed_at,
        exit_price_sol     = @exit_price_sol,
        gross_pnl_pct      = @gross_pnl_pct,
        net_pnl_pct        = @net_pnl_pct,
        hold_minutes       = @hold_minutes,
        close_reason       = @close_reason,
        exit_metrics_json  = @exit_metrics_json,
        simulated_fee_pct  = @simulated_fee_pct,
        exit_technique     = @exit_technique,
        outcome_valid      = @outcome_valid,
        status             = 'closed'
    WHERE id = @id
  `).run({ outcome_valid: 1, ...data, id })
}

// Phase 5: insert a live Meridian outcome. INSERT OR IGNORE on outcome_id dedups
// double-pushes (same close relayed from multiple Meridian paths). Returns true if inserted.
function recordFeedbackOutcome(data) {
  const r = getStmt('insertFeedbackOutcome', `
    INSERT OR IGNORE INTO feedback_outcomes
      (created_at, outcome_id, source, pool_address, token_symbol, strategy,
       entry_technique, technique_author, exit_technique, pnl_pct, fees_earned_usd,
       win, minutes_held, close_reason, condition_bucket, linked_decision_id, features_json)
    VALUES
      (@created_at, @outcome_id, @source, @pool_address, @token_symbol, @strategy,
       @entry_technique, @technique_author, @exit_technique, @pnl_pct, @fees_earned_usd,
       @win, @minutes_held, @close_reason, @condition_bucket, @linked_decision_id, @features_json)
  `).run(data)
  return r.changes > 0
}

function recordRejection(data) {
  return getStmt('insertRejection', `
    INSERT INTO screening_rejections
      (scanned_at, pool_address, token_symbol, token_mint, reject_stage, reason, key_metrics)
    VALUES
      (@scanned_at, @pool_address, @token_symbol, @token_mint, @reject_stage, @reason, @key_metrics)
  `).run(data)
}

function recordWalletAction(data) {
  return getStmt('insertWalletAction2', `
    INSERT OR IGNORE INTO wallet_actions
      (detected_at, signature, action_type, pool_address, token_mint, token_symbol,
       strategy, amount_sol, matched_decision_id, match_category,
       wallet_address, wallet_label, wallet_type)
    VALUES
      (@detected_at, @signature, @action_type, @pool_address, @token_mint, @token_symbol,
       @strategy, @amount_sol, @matched_decision_id, @match_category,
       @wallet_address, @wallet_label, @wallet_type)
  `).run(data)
}

/**
 * Authoritative pattern write used by the reconciliation job — overwrites win_rate/wins/
 * mean_pnl/sample_count/active recomputed from source. Does NOT touch ema_win_rate (no
 * per-sample replay in v1; the EMA is a best-effort live-scoring signal only).
 */
function recordPatternReconciled(vb, regime, strategy, d) {
  return getStmt('reconcilePattern', `
    INSERT INTO pattern_library
      (updated_at, volatility_bucket, regime, strategy, win_rate, mean_pnl_net, sample_count, active, wins, last_reconciled_at,
       source, live_win_rate, live_mean_pnl, live_sample_count, sim_win_rate, sim_sample_count, reality_gap,
       avg_win_pnl, avg_loss_pnl)
    VALUES (@updated_at, @vb, @regime, @strategy, @win_rate, @mean_pnl_net, @sample_count, @active, @wins, @last_reconciled_at,
       @source, @live_win_rate, @live_mean_pnl, @live_sample_count, @sim_win_rate, @sim_sample_count, @reality_gap,
       @avg_win_pnl, @avg_loss_pnl)
    ON CONFLICT(volatility_bucket, regime, strategy) DO UPDATE SET
      updated_at         = excluded.updated_at,
      win_rate           = excluded.win_rate,
      mean_pnl_net       = excluded.mean_pnl_net,
      sample_count       = excluded.sample_count,
      active             = excluded.active,
      wins               = excluded.wins,
      last_reconciled_at = excluded.last_reconciled_at,
      source             = excluded.source,
      live_win_rate      = excluded.live_win_rate,
      live_mean_pnl      = excluded.live_mean_pnl,
      live_sample_count  = excluded.live_sample_count,
      sim_win_rate       = excluded.sim_win_rate,
      sim_sample_count   = excluded.sim_sample_count,
      reality_gap        = excluded.reality_gap,
      avg_win_pnl        = excluded.avg_win_pnl,
      avg_loss_pnl       = excluded.avg_loss_pnl
  `).run({ vb, regime, strategy,
    source: null, live_win_rate: null, live_mean_pnl: null, live_sample_count: 0,
    sim_win_rate: null, sim_sample_count: 0, reality_gap: null,
    avg_win_pnl: null, avg_loss_pnl: null, ...d })
}

/**
 * Insert a new capability gap or refresh an existing one (by signature).
 * Returns { inserted } so the caller alerts only on the OPEN transition, never on refresh.
 */
function openOrUpdateGap(g) {
  const existing = db.prepare(`SELECT id, status FROM capability_gaps WHERE signature = ?`).get(g.signature)
  if (existing) {
    db.prepare(`
      UPDATE capability_gaps SET
        severity = @severity, saturation_pct = @saturation_pct, denominator = @denominator,
        sustained_scans = @sustained_scans, observation_count = @observation_count,
        last_seen_at = @last_seen_at, evidence_json = @evidence_json, suggested_action = @suggested_action,
        status = CASE WHEN status = 'muted' THEN 'muted' ELSE 'open' END
      WHERE signature = @signature
    `).run(g)
    return { inserted: false, reopened: existing.status === 'resolved' }
  }
  db.prepare(`
    INSERT INTO capability_gaps
      (signature, kind, reason_key, strategy, severity, saturation_pct, denominator,
       sustained_scans, observation_count, status, first_seen_at, last_seen_at, evidence_json, suggested_action)
    VALUES
      (@signature, @kind, @reason_key, @strategy, @severity, @saturation_pct, @denominator,
       @sustained_scans, @observation_count, 'open', @first_seen_at, @last_seen_at, @evidence_json, @suggested_action)
  `).run(g)
  return { inserted: true }
}

/** Resolve open gaps not re-observed since `beforeIso` (the diagnosis window). */
function resolveStaleGaps(beforeIso) {
  return db.prepare(
    `UPDATE capability_gaps SET status = 'resolved' WHERE status = 'open' AND last_seen_at < ?`
  ).run(beforeIso)
}

function listOpenGaps() {
  return db.prepare(`
    SELECT * FROM capability_gaps WHERE status = 'open'
    ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen_at DESC
  `).all()
}

function recordSystemReport(d) {
  return db.prepare(`
    INSERT INTO system_reports (generated_at, via, llm_fallback, report_text, bundle_json)
    VALUES (@generated_at, @via, @llm_fallback, @report_text, @bundle_json)
  `).run(d)
}

function recordTuningEvent(d) {
  return db.prepare(`
    INSERT INTO tuning_events
      (created_at, param_path, old_value, new_value, delta, strategy, reason, sample_count,
       win_rate, wilson_lb, mean_pnl_net, metric_confidence, mode, status, reverted_from)
    VALUES
      (@created_at, @param_path, @old_value, @new_value, @delta, @strategy, @reason, @sample_count,
       @win_rate, @wilson_lb, @mean_pnl_net, @metric_confidence, @mode, @status, @reverted_from)
  `).run(d)
}

function getTuningEvents(limit = 20) {
  return db.prepare(`SELECT * FROM tuning_events ORDER BY created_at DESC LIMIT ?`).all(limit)
}

/** Record a price observation, maintaining the per-token all-time-high water mark. */
function recordTokenPrice(mint, price, ts) {
  if (!mint || !(price > 0)) return
  return getStmt('recordTokenPrice', `
    INSERT INTO token_ath (token_mint, ath_price_sol, ath_seen_at, last_price_sol, observations, first_seen_at, updated_at)
    VALUES (@mint, @price, @ts, @price, 1, @ts, @ts)
    ON CONFLICT(token_mint) DO UPDATE SET
      ath_price_sol  = CASE WHEN @price > ath_price_sol THEN @price ELSE ath_price_sol END,
      ath_seen_at    = CASE WHEN @price > ath_price_sol THEN @ts   ELSE ath_seen_at   END,
      last_price_sol = @price,
      observations   = observations + 1,
      updated_at     = @ts
  `).run({ mint, price, ts })
}

function getTokenAth(mint) {
  if (!mint) return null
  return db.prepare(`SELECT * FROM token_ath WHERE token_mint = ?`).get(mint)
}

module.exports = {
  initSchema, db,
  recordDecision, expireDecision, markFollowed,
  recordDryRunPosition, closeDryRunPosition, recordFeedbackOutcome,
  recordWalletAction, recordRejection, recordPatternReconciled,
  openOrUpdateGap, resolveStaleGaps, listOpenGaps,
  recordSystemReport, recordTuningEvent, getTuningEvents,
  recordTokenPrice, getTokenAth,
}
