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

  console.log('[Schema] ✓ Database schema ready')
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

module.exports = { initSchema, db, recordDecision, expireDecision, markFollowed, recordDryRunPosition, closeDryRunPosition }
