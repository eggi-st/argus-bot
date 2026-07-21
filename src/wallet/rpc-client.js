'use strict'
const { Connection, PublicKey } = require('@solana/web3.js')

// web3.js Connection has NO request timeout, so a black-holing endpoint (TCP connects,
// never responds — common with a degraded/throttled RPC) makes an RPC await hang forever.
// A hang is invisible to error-based fallback + the observer's health counter, which would
// reproduce a silent observation stall. Race every call against this timeout so a hang
// becomes a throw that rotates the fallback and trips the down-detector.
const RPC_TIMEOUT_MS = 12_000

// Per-endpoint Connection cache. Keyed by URL so rotating between a primary
// (e.g. a rate-limited Helius key) and public fallbacks reuses warm connections.
const _conns = new Map()

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms${label ? ` (${label})` : ''}`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function getConn(rpcUrl) {
  let conn = _conns.get(rpcUrl)
  if (!conn) {
    conn = new Connection(rpcUrl, 'confirmed')
    _conns.set(rpcUrl, conn)
  }
  return conn
}

/** Normalize a string|array endpoint arg into a de-duped, non-empty URL list. */
function toEndpoints(rpcUrls) {
  const list = Array.isArray(rpcUrls) ? rpcUrls : [rpcUrls]
  return [...new Set(list.filter(Boolean))]
}

/**
 * Run `fn(conn)` against each endpoint in order, returning the first success.
 * Only throws (the last error) when EVERY endpoint fails — so a single throttled
 * key degrades to a fallback instead of silently killing observation.
 */
async function withFallback(rpcUrls, fn) {
  const endpoints = toEndpoints(rpcUrls)
  if (!endpoints.length) throw new Error('no RPC endpoint configured')
  let lastErr
  for (const url of endpoints) {
    try {
      return await withTimeout(fn(getConn(url), url), RPC_TIMEOUT_MS, url.replace(/api-key=[^&]+/, 'api-key=***'))
    } catch (e) {
      lastErr = e
      if (endpoints.length > 1) {
        console.warn(`[RPC] ${url.replace(/api-key=[^&]+/, 'api-key=***')} failed: ${e.message} — trying next`)
      }
    }
  }
  throw lastErr
}

async function getSignaturesForAddress(rpcUrls, address, opts = {}) {
  const pubkey = new PublicKey(address)
  return withFallback(rpcUrls, conn => conn.getSignaturesForAddress(pubkey, {
    limit: opts.limit ?? 20,
    ...(opts.until && { until: opts.until }),
  }))
}

async function getParsedTransaction(rpcUrls, signature) {
  return withFallback(rpcUrls, conn => conn.getParsedTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  }))
}

module.exports = { getSignaturesForAddress, getParsedTransaction, withFallback }
