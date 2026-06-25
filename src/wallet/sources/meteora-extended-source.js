'use strict'
// Extended Meteora source: seeds from Pool Discovery API directly (top pools by volume)
// instead of only Argus-validated decisions. Covers pools Argus hasn't seen yet.
// Zero extra API keys — uses existing Meteora public API + RPC.

const fetch = require('node-fetch')
const { getSignaturesForAddress, getParsedTransaction } = require('../rpc-client')
const { parseMeteoraTx } = require('../tx-parser')

const POOL_DISCOVERY_BASE = 'https://pool-discovery-api.datapi.meteora.ag'
const TOP_POOLS           = 20    // scan top N pools by volume
const SIGS_PER_POOL       = 12    // transactions per pool (RPC calls)
const MIN_POOL_HITS       = 2     // wallet must appear in ≥ N pools

async function fetchTopPools(cfg) {
  const screening = cfg.screening || {}
  const timeframe  = screening.timeframe || '30m'
  const category   = screening.category  || 'all'

  // Same endpoint as screener — top pools ordered by fee_tvl_ratio (yield signal)
  const url = `${POOL_DISCOVERY_BASE}/pools` +
    `?page_size=${TOP_POOLS}` +
    `&filter_by=fee_tvl_ratio` +
    `&timeframe=${timeframe}` +
    `&category=${category}`

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    timeout: 15_000,
  })
  if (!res.ok) throw new Error(`Pool Discovery API HTTP ${res.status}`)

  const json = await res.json()
  const pools = json?.pairs || json?.pools || json?.data || json || []
  return Array.isArray(pools) ? pools : []
}

async function discoverFromMeteoraExtended({ rpcUrl, cfg }) {
  const pools = await fetchTopPools(cfg)
  if (!pools.length) throw new Error('Pool Discovery API returned 0 pools')

  // wallet → Set of distinct pool addresses they LP'd in
  const walletPools = new Map()

  for (const pool of pools) {
    // Pool address field varies by API version
    const poolAddr = pool.address || pool.pool || pool.pair_address || pool.pairAddress
    if (!poolAddr) continue

    let sigs
    try {
      sigs = await getSignaturesForAddress(rpcUrl, poolAddr, { limit: SIGS_PER_POOL })
    } catch (e) {
      console.warn(`[Meteora-Ext] Skip ${poolAddr.slice(0, 8)}: ${e.message}`)
      continue
    }

    for (const sig of (sigs || []).filter(s => !s.err)) {
      let tx
      try { tx = await getParsedTransaction(rpcUrl, sig.signature) } catch { continue }

      const action = parseMeteoraTx(tx, sig.signature)
      if (!action || !['add_liquidity', 'open_position'].includes(action.actionType)) continue

      const signerKey = tx?.transaction?.message?.accountKeys?.find(k => k.signer)
      const lpWallet  = signerKey?.pubkey?.toString?.() || signerKey?.pubkey
      if (!lpWallet || typeof lpWallet !== 'string' || lpWallet.length < 32) continue

      if (!walletPools.has(lpWallet)) walletPools.set(lpWallet, new Set())
      walletPools.get(lpWallet).add(poolAddr)
    }
  }

  const candidates = []
  for (const [address, pools] of walletPools) {
    if (pools.size >= MIN_POOL_HITS) {
      candidates.push({ address, label: `mex_${address.slice(0, 6)}`, pool_hits: pools.size })
    }
  }

  return candidates
}

module.exports = { discoverFromMeteoraExtended }
