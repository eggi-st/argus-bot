'use strict'
// Meteora on-chain discovery: scans recent top-pool transactions to find
// wallets that consistently add liquidity across multiple quality pools.
// No extra API key needed — uses existing RPC connection.

const { getSignaturesForAddress, getParsedTransaction } = require('../rpc-client')
const { parseMeteoraTx } = require('../tx-parser')

const MIN_POOL_HITS = 2   // wallet must appear in ≥ N distinct pools
const SIGS_PER_POOL = 15  // how many recent transactions to scan per pool
const MAX_POOLS     = 8   // max seed pools to scan (controls RPC usage)

/**
 * Discover smart money wallets from Meteora on-chain activity.
 *
 * Algorithm:
 *   1. Seed from recent Argus-validated pool addresses (decisions table)
 *   2. For each pool, fetch recent add_liquidity transactions
 *   3. Extract the signing wallet (LP provider = first signer)
 *   4. Qualify wallets appearing in ≥ MIN_POOL_HITS distinct pools
 *
 * RPC cost: MAX_POOLS × SIGS_PER_POOL calls (~120 RPC calls max on 6h schedule)
 */
async function discoverFromMeteora({ rpcUrl }) {
  const db = require('../../db/database')

  // Use Argus-validated pool addresses as seeds (no extra API calls)
  const recentPools = db.prepare(`
    SELECT DISTINCT pool_address
    FROM decisions
    WHERE pool_address IS NOT NULL
      AND created_at > datetime('now', '-7 days')
    LIMIT ?
  `).all(MAX_POOLS)

  if (!recentPools.length) {
    throw new Error('No recent decisions to seed from — run a scan first')
  }

  // wallet address → Set of distinct pool addresses they LP'd in
  const walletPools = new Map()

  for (const { pool_address } of recentPools) {
    let sigs
    try {
      sigs = await getSignaturesForAddress(rpcUrl, pool_address, { limit: SIGS_PER_POOL })
    } catch (e) {
      console.warn(`[Meteora-Source] Skip pool ${pool_address.slice(0, 8)}: ${e.message}`)
      continue
    }

    for (const sig of (sigs || []).filter(s => !s.err)) {
      let tx
      try {
        tx = await getParsedTransaction(rpcUrl, sig.signature)
      } catch { continue }

      const action = parseMeteoraTx(tx, sig.signature)
      if (!action || !['add_liquidity', 'open_position'].includes(action.actionType)) continue

      // First signer = the wallet that initiated the LP action
      const signerKey = tx?.transaction?.message?.accountKeys?.find(k => k.signer)
      const lpWallet  = signerKey?.pubkey?.toString?.() || signerKey?.pubkey
      if (!lpWallet || typeof lpWallet !== 'string' || lpWallet.length < 32) continue

      if (!walletPools.has(lpWallet)) walletPools.set(lpWallet, new Set())
      walletPools.get(lpWallet).add(pool_address)
    }
  }

  // Qualify: appeared in ≥ MIN_POOL_HITS distinct quality pools = smart money proxy
  const candidates = []
  for (const [address, pools] of walletPools) {
    if (pools.size >= MIN_POOL_HITS) {
      candidates.push({
        address,
        label:     `sm_${address.slice(0, 6)}`,
        pool_hits: pools.size,
      })
    }
  }

  return candidates
}

module.exports = { discoverFromMeteora }
