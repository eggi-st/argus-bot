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
  const snap = await getPoolSnapshot(poolAddress)
  return snap?.price ?? null
}

/**
 * Fetch price + exit metrics for a pool in one API call.
 * Used by the dry-run engine to capture pool state at close time.
 * Returns null if the pool is no longer available.
 */
async function getPoolSnapshot(poolAddress) {
  if (!poolAddress) return null
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=30m`
  try {
    const res = await fetch(url, { timeout: FETCH_TIMEOUT_MS })
    if (!res.ok) return null
    const data = await res.json()
    const p = (data.data || [])[0]
    if (!p?.pool_price) return null
    return {
      price:              parseFloat(p.pool_price),
      fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? parseFloat(p.fee_active_tvl_ratio) : null,
      volatility:           p.volatility            != null ? parseFloat(p.volatility)            : null,
      volume_change_pct:    p.volume_change_pct     != null ? parseFloat(p.volume_change_pct)     : null,
      price_change_pct:     p.pool_price_change_pct != null ? parseFloat(p.pool_price_change_pct) : null,
      tvl:                  p.tvl                   != null ? parseFloat(p.tvl)                   : null,
    }
  } catch {
    return null
  }
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

// ── Pool → token identity resolver (for the Wallet Observer) ──────────────────
// Resolves an account to its base token via the same pool-discovery endpoint.
// Cached so the observer never re-queries the same account: a positive cache of
// resolved pools and a negative set of accounts confirmed NOT to be pools.
const _poolTokenCache = new Map()   // poolAddress → { pool_address, token_mint, token_symbol }
const _notAPool       = new Set()   // accounts confirmed to not be a Meteora pool

/**
 * Given a candidate account, return { pool_address, token_mint, token_symbol }
 * if it is a Meteora pool, else null. Results are cached (both hits and misses).
 */
async function getPoolToken(account) {
  if (!account) return null
  if (_poolTokenCache.has(account)) return _poolTokenCache.get(account)
  if (_notAPool.has(account)) return null

  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${account}`)}&timeframe=30m`
  try {
    const res = await fetch(url, { timeout: FETCH_TIMEOUT_MS })
    if (!res.ok) { _notAPool.add(account); return null }
    const data = await res.json()
    const p = (data.data || [])[0]
    const base = p?.token_x || {}
    if (!p || !base.address) { _notAPool.add(account); return null }
    const info = {
      pool_address: account,
      token_mint:   base.address,
      token_symbol: base.symbol || null,
    }
    _poolTokenCache.set(account, info)
    return info
  } catch {
    return null   // transient error — don't poison the negative cache
  }
}

/**
 * Resolve the first account in a list that is a Meteora pool. Bounded to the
 * first `max` accounts (the lbPair appears early in Meteora instructions).
 */
async function resolvePoolFromAccounts(accounts, max = 5) {
  for (const acc of (accounts || []).slice(0, max)) {
    const info = await getPoolToken(acc)
    if (info) return info
  }
  return null
}

module.exports = { getPoolPrice, getPoolSnapshot, getDexscreenerPrice, getPriceForPosition, getPoolToken, resolvePoolFromAccounts }
