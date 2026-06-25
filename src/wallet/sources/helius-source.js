'use strict'
// Helius enhanced transaction API — cleaner LP detection than raw RPC.
// Helius returns structured type:"ADD_LIQUIDITY" / source:"METEORA_DLMM"
// so no logMessages parsing needed.
// Free tier: https://helius.xyz — 100k credits/month, sufficient for 6h cycles.
// Config: { "helius": { "apiKey": "your-key-here" } } in user-config.json

const fetch = require('node-fetch')

const HELIUS_BASE  = 'https://api.helius.xyz/v0'
const SIGS_PER_POOL = 20
const MIN_POOL_HITS = 2
const MAX_POOLS     = 10

const METEORA_TYPES = new Set([
  'ADD_LIQUIDITY', 'REMOVE_LIQUIDITY', 'DEPOSIT', 'WITHDRAW',
  'INCREASE_LIQUIDITY', 'DECREASE_LIQUIDITY',
])
const METEORA_SOURCES = new Set([
  'METEORA', 'METEORA_DLMM', 'METEORA_POOLS',
])

async function fetchHeliusTransactions(apiKey, address, limit) {
  const url = `${HELIUS_BASE}/addresses/${address}/transactions` +
    `?api-key=${apiKey}&limit=${limit}`

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    timeout: 15_000,
  })

  if (res.status === 429) throw new Error('Helius rate limit — will retry next cycle')
  if (res.status === 401) throw new Error('Helius API key invalid or expired')
  if (!res.ok) throw new Error(`Helius HTTP ${res.status}`)

  return res.json()
}

async function discoverFromHelius({ rpcUrl, cfg }) {
  const apiKey = cfg.helius?.apiKey
  if (!apiKey) throw new Error('Helius API key not set — add helius.apiKey to user-config.json')

  const db = require('../../db/database')

  // Seed from recent Argus-validated pool addresses (no extra API call)
  const recentPools = db.prepare(`
    SELECT DISTINCT pool_address FROM decisions
    WHERE pool_address IS NOT NULL
      AND created_at > datetime('now', '-7 days')
    LIMIT ?
  `).all(MAX_POOLS)

  if (!recentPools.length) throw new Error('No recent decisions to seed from')

  // wallet → Set of distinct pools they added liquidity to
  const walletPools = new Map()

  for (const { pool_address } of recentPools) {
    let txs
    try {
      txs = await fetchHeliusTransactions(apiKey, pool_address, SIGS_PER_POOL)
    } catch (e) {
      // Re-throw rate limit / auth errors so orchestrator marks failure
      if (e.message.includes('rate limit') || e.message.includes('invalid')) throw e
      console.warn(`[Helius-Source] Skip ${pool_address.slice(0, 8)}: ${e.message}`)
      continue
    }

    for (const tx of (txs || [])) {
      // Filter for Meteora LP actions
      const isLp = METEORA_TYPES.has(tx.type) || METEORA_SOURCES.has(tx.source)
      if (!isLp) continue

      // feePayer is the wallet that signed the LP transaction
      const lpWallet = tx.feePayer
      if (!lpWallet || lpWallet.length < 32) continue

      if (!walletPools.has(lpWallet)) walletPools.set(lpWallet, new Set())
      walletPools.get(lpWallet).add(pool_address)
    }

    // Small delay — Helius free tier allows ~10 req/s
    await new Promise(r => setTimeout(r, 120))
  }

  const candidates = []
  for (const [address, pools] of walletPools) {
    if (pools.size >= MIN_POOL_HITS) {
      candidates.push({ address, label: `hls_${address.slice(0, 6)}`, pool_hits: pools.size })
    }
  }

  return candidates
}

module.exports = { discoverFromHelius }
