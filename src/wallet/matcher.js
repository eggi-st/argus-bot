'use strict'
const db = require('../db/database')

/**
 * Given a parsed wallet action, check if it corresponds to an Argus decision.
 * Matching strategy:
 *   1. Any involved account matches an active decision's pool_address
 *   2. Any involved account matches an open dry_run_position's pool_address
 *   3. No match → user_only (counterfactual data)
 */
function matchToDecision(action) {
  const { involvedAccounts } = action

  // Strategy 1: active decision exact pool match
  for (const acc of involvedAccounts) {
    const dec = db.prepare(`
      SELECT id, pool_address, token_mint, token_symbol, strategy
      FROM decisions
      WHERE pool_address = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 1
    `).get(acc)
    if (dec) {
      return {
        matchedDecisionId: dec.id,
        matchCategory: 'followed',
        poolAddress: dec.pool_address,
        tokenMint: dec.token_mint,
        tokenSymbol: dec.token_symbol,
        strategy: dec.strategy,
      }
    }
  }

  // Strategy 2: open dry_run_position pool match (catches recently expired decisions)
  for (const acc of involvedAccounts) {
    const pos = db.prepare(`
      SELECT dr.pool_address, dr.token_mint, dr.token_symbol, dr.strategy, dr.decision_id
      FROM dry_run_positions dr
      WHERE dr.pool_address = ? AND dr.status = 'open'
      LIMIT 1
    `).get(acc)
    if (pos) {
      return {
        matchedDecisionId: pos.decision_id,
        matchCategory: 'followed',
        poolAddress: pos.pool_address,
        tokenMint: pos.token_mint,
        tokenSymbol: pos.token_symbol,
        strategy: pos.strategy,
      }
    }
  }

  // No match — counterfactual: user did something Argus didn't recommend
  return {
    matchedDecisionId: null,
    matchCategory: 'user_only',
    // heuristic: pool is often the 2nd or 3rd account in Meteora instructions
    poolAddress: involvedAccounts[1] || involvedAccounts[0] || null,
    tokenMint: null,
    tokenSymbol: null,
    strategy: null,
  }
}

/**
 * Match + record a parsed action. Marks the matched decision as 'followed'.
 * Returns the record that was (attempted to be) inserted.
 */
function processAction(action, { recordWalletAction, markFollowed }) {
  const match = matchToDecision(action)

  const record = {
    detected_at:        action.blockTime || new Date().toISOString(),
    signature:          action.signature,
    action_type:        action.actionType,
    pool_address:       match.poolAddress,
    token_mint:         match.tokenMint,
    token_symbol:       match.tokenSymbol,
    strategy:           match.strategy,
    amount_sol:         null,
    matched_decision_id: match.matchedDecisionId,
    match_category:     match.matchCategory,
  }

  recordWalletAction(record)

  if (match.matchedDecisionId) {
    markFollowed(match.matchedDecisionId)
    console.log(`[Wallet] ✓ Followed decision #${match.matchedDecisionId} — ${action.actionType} on ${match.tokenSymbol || match.poolAddress?.slice(0, 8)}`)
  } else {
    const pool = match.poolAddress?.slice(0, 8) || '?'
    console.log(`[Wallet] user_only — ${action.actionType} on pool ${pool}… (counterfactual)`)
  }

  return record
}

module.exports = { matchToDecision, processAction }
