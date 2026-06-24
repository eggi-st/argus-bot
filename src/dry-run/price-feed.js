'use strict'
const fetch = require('node-fetch')

const POOL_DISCOVERY_BASE = 'https://pool-discovery-api.datapi.meteora.ag'
const DEXSCREENER_BASE = 'https://api.dexscreener.com'
const FETCH_TIMEOUT_MS = 8_000

/**
 * Fetch current price via Meteora Pool Discovery for a specific pool.
 * Returns pool_price in SOL terms (same source as entry_price_sol from screener).
 */
async function getPoolPrice(poolAddress) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=5m`
  const res = await fetch(url, { timeout: FETCH_TIMEOUT_MS })
  if (!res.ok) return null
  const data = await res.json()
  const pool = (data.data || [])[0]
  if (!pool?.pool_price) return null
  return parseFloat(pool.pool_price)
}

/**
 * Fallback: DexScreener for price by token mint.
 * Prefers TOKEN/SOL pair (priceNative = SOL denomination).
 * Returns { price_sol, price_usd } or null.
 */
async function getDexscreenerPrice(mint) {
  const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/tokens/${mint}`, { timeout: FETCH_TIMEOUT_MS })
  if (!res.ok) return null
  const data = await res.json()
  const pairs = data?.pairs
  if (!Array.isArray(pairs) || !pairs.length) return null

  const solPairs = pairs
    .filter(p => p.quoteToken?.symbol === 'SOL' || p.quoteToken?.symbol === 'WSOL')
    .sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0))
  const best = solPairs[0] ||
    pairs.sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0))[0]
  if (!best) return null

  return {
    price_sol: solPairs.length ? parseFloat(best.priceNative || 0) : null,
    price_usd: parseFloat(best.priceUsd || 0),
  }
}

/**
 * Get current price for a dry run position update.
 * Priority: Meteora pool detail (accurate, same unit as entry) → DexScreener SOL pair.
 * Returns price in SOL or null if both fail.
 */
async function getPriceForPosition(tokenMint, poolAddress) {
  if (poolAddress) {
    try {
      const p = await getPoolPrice(poolAddress)
      if (p != null && p > 0) return p
    } catch {}
  }
  if (tokenMint) {
    try {
      const d = await getDexscreenerPrice(tokenMint)
      if (d?.price_sol != null && d.price_sol > 0) return d.price_sol
    } catch {}
  }
  return null
}

module.exports = { getPoolPrice, getDexscreenerPrice, getPriceForPosition }
