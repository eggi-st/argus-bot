'use strict'
// OKX smart money source — discovers wallets flagged by OKX as smart money
// on Solana DEX activity. Requires OKX API key in user-config.json:
//   { "okx": { "apiKey": "...", "secretKey": "...", "passphrase": "..." } }
//
// OKX DEX API docs: https://www.okx.com/web3/build/docs/waas/dex-smart-money

const fetch  = require('node-fetch')
const crypto = require('crypto')

async function discoverFromOkx({ cfg }) {
  const okx = cfg.okx || {}

  if (!okx.apiKey) {
    throw new Error('OKX API key not configured — add okx.apiKey to user-config.json')
  }

  // OKX chain ID for Solana is numeric '501', not the string 'solana'
  const chain    = '501'
  const baseUrl  = okx.baseUrl || 'https://www.okx.com'
  const endpoint = `${baseUrl}/api/v5/dex/market/smart-money?chainId=${chain}&limit=50`

  const ts      = new Date().toISOString()
  const method  = 'GET'
  const path    = `/api/v5/dex/market/smart-money?chainId=${chain}&limit=50`
  const sign    = crypto.createHmac('sha256', okx.secretKey || '')
    .update(`${ts}${method}${path}`)
    .digest('base64')

  let res
  try {
    res = await fetch(endpoint, {
      headers: {
        'OK-ACCESS-KEY':        okx.apiKey,
        'OK-ACCESS-SIGN':       sign,
        'OK-ACCESS-TIMESTAMP':  ts,
        'OK-ACCESS-PASSPHRASE': okx.passphrase || '',
        'Content-Type':         'application/json',
      },
      timeout: 15_000,
    })
  } catch (e) {
    throw new Error(`OKX network error: ${e.message}`)
  }

  if (!res.ok) throw new Error(`OKX API HTTP ${res.status}`)

  const json = await res.json()
  if (json.code !== '0') throw new Error(`OKX API error: ${json.msg || json.code}`)

  const wallets = (json.data || [])
    .filter(item => item.address || item.walletAddress)
    .map(item => ({
      address:   item.address || item.walletAddress,
      label:     `okx_${(item.address || '').slice(0, 6)}`,
      pool_hits: item.txCount || 1,
    }))

  return wallets
}

module.exports = { discoverFromOkx }
