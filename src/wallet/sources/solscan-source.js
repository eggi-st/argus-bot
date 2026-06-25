'use strict'
// Solscan public API — top token holders as smart money candidates.
// No API key needed. Rate limited (~1 req/sec on free tier).
// Signal: large holders of tokens Argus recommends are likely informed.
// Lower precision than cross-pool LP scan, but adds a different dimension.

const fetch = require('node-fetch')

const SOLSCAN_BASE   = 'https://api.solscan.io'
const HOLDERS_LIMIT  = 15
const MAX_TOKENS     = 5
const REQ_DELAY_MS   = 1100   // stay under ~60 req/min rate limit

// Known program / system accounts to skip (not real wallets)
const SKIP_PREFIXES = [
  'TokenkegQ', 'So111111', '11111111', 'ATokenGP', 'metaqbxx',
  'Memo1Ukk', 'ComputeBudget', 'SysvarRent', 'SysvarC1',
]
function isSystemAccount(addr) {
  return SKIP_PREFIXES.some(p => addr.startsWith(p))
}

async function fetchTopHolders(tokenMint) {
  const url = `${SOLSCAN_BASE}/v2/token/holders` +
    `?tokenAddress=${tokenMint}&offset=0&limit=${HOLDERS_LIMIT}`

  const res = await fetch(url, {
    headers: {
      'Accept':     'application/json',
      'User-Agent': 'Argus-HivemindBot/1.0',
    },
    timeout: 12_000,
  })

  if (res.status === 429) throw new Error('Solscan rate limit hit')
  if (res.status === 403) throw new Error('Solscan access denied — endpoint may require auth')
  if (!res.ok) throw new Error(`Solscan HTTP ${res.status}`)

  const json = await res.json()
  // API may return { data: [...] } or { result: [...] } depending on version
  return json?.data || json?.result || []
}

async function discoverFromSolscan({ cfg }) {
  const db = require('../../db/database')

  // Tokens from recent Argus decisions (already validated by IC)
  const tokens = db.prepare(`
    SELECT DISTINCT token_mint, token_symbol FROM decisions
    WHERE token_mint IS NOT NULL
      AND created_at > datetime('now', '-7 days')
    LIMIT ?
  `).all(MAX_TOKENS)

  if (!tokens.length) throw new Error('No recent token data — run a scan first')

  const candidates = []
  const seen = new Set()

  for (const { token_mint, token_symbol } of tokens) {
    let holders
    try {
      holders = await fetchTopHolders(token_mint)
    } catch (e) {
      // Re-throw errors that mean the source itself is broken
      if (e.message.includes('rate limit') || e.message.includes('denied')) throw e
      console.warn(`[Solscan-Source] Skip ${token_symbol}: ${e.message}`)
      await new Promise(r => setTimeout(r, REQ_DELAY_MS))
      continue
    }

    for (const h of (holders || [])) {
      // Address field varies by Solscan API version
      const addr = h.address || h.owner || h.walletAddress
      if (!addr || addr.length < 32) continue
      if (isSystemAccount(addr))      continue
      if (seen.has(addr))             continue

      seen.add(addr)
      candidates.push({
        address:   addr,
        label:     `sc_${(token_symbol || token_mint).slice(0, 6)}_${addr.slice(0, 4)}`,
        pool_hits: 1,
      })
    }

    // Respect rate limit between requests
    await new Promise(r => setTimeout(r, REQ_DELAY_MS))
  }

  if (!candidates.length) throw new Error('Solscan returned no usable holder data')
  return candidates
}

module.exports = { discoverFromSolscan }
