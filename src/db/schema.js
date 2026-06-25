'use strict'
const db = require('./database')

function initSchema() {
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

  migrateSchema()
  console.log('[Schema] ✓ Database schema ready')
}

// ALTER TABLE migrations — safe to re-run (duplicate column errors are silently ignored)
function migrateSchema() {
  const cols = [
    `ALTER TABLE wallet_actions ADD COLUMN wallet_address TEXT`,
    `ALTER TABLE wallet_actions ADD COLUMN wallet_label TEXT`,
    `ALTER TABLE wallet_actions ADD COLUMN wallet_type TEXT DEFAULT 'own'`,
  ]
  let added = 0
  for (const sql of cols) {
    try { db.exec(sql); added++ } catch (e) {
      if (!e.message?.includes('duplicate column')) console.warn('[Schema] Migration:', e.message)
    }
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_wallet_type ON wallet_actions(wallet_type, detected_at)`)
  } catch {}
  if (added) console.log(`[Schema] Added ${added} column(s) to wallet_actions`)
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
       indicators_json, strategy_scores_json, llm_verdict, confidence, condition_bucket)
    VALUES
      (@created_at, @expires_at, @token_mint, @token_symbol, @pool_address, @strategy,
       @indicators_json, @strategy_scores_json, @llm_verdict, @confidence, @condition_bucket)
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
       entry_price_sol, entry_bin, range_bins, sol_amount, simulated_slippage_pct, tx_cost_usd)
    VALUES
      (@decision_id, @opened_at, @token_mint, @token_symbol, @pool_address, @strategy,
       @entry_price_sol, @entry_bin, @range_bins, @sol_amount, @simulated_slippage_pct, @tx_cost_usd)
  `).run(data)
}

function closeDryRunPosition(id, data) {
  return getStmt('closeDryRun', `
    UPDATE dry_run_positions
    SET closed_at = @closed_at, exit_price_sol = @exit_price_sol,
        gross_pnl_pct = @gross_pnl_pct, net_pnl_pct = @net_pnl_pct,
        hold_minutes = @hold_minutes, outcome_valid = 1, status = 'closed'
    WHERE id = @id
  `).run({ id, ...data })
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

module.exports = {
  initSchema, db,
  recordDecision, expireDecision, markFollowed,
  recordDryRunPosition, closeDryRunPosition,
  recordWalletAction,
}
