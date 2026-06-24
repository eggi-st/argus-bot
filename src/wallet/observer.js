'use strict'
const bus = require('../core/event-bus')
const { getSignaturesForAddress, getParsedTransaction } = require('./rpc-client')
const { parseMeteoraTx } = require('./tx-parser')
const { processAction } = require('./matcher')
const { recordWalletAction, markFollowed } = require('../db/schema')

let _timer      = null
let _lastSig    = null   // newest signature already seen (cursor)
let _walletAddr = null

/**
 * One poll cycle: fetch new signatures → parse → match → emit.
 */
async function pollOnce(walletAddress, rpcUrl) {
  let sigs
  try {
    sigs = await getSignaturesForAddress(rpcUrl, walletAddress, {
      limit: 20,
      until: _lastSig || undefined,
    })
  } catch (e) {
    console.warn(`[Wallet] getSignaturesForAddress error: ${e.message}`)
    return
  }

  if (!sigs?.length) return

  const newest = sigs[0].signature

  // First run: initialize cursor, don't process historical transactions
  if (!_lastSig) {
    _lastSig = newest
    console.log(`[Wallet] Cursor initialized at ${newest.slice(0, 8)}…`)
    return
  }

  _lastSig = newest

  // Skip failed transactions
  const fresh = sigs.filter(s => !s.err)
  if (!fresh.length) return

  console.log(`[Wallet] ${fresh.length} new tx(s) to check`)

  let found = 0
  for (const sig of fresh) {
    try {
      const txResult = await getParsedTransaction(rpcUrl, sig.signature)
      const action = parseMeteoraTx(txResult, sig.signature)
      if (!action) continue

      const record = processAction(action, { recordWalletAction, markFollowed })
      found++

      bus.emitSafe('wallet_action_detected', {
        action_type:    record.action_type,
        token_symbol:   record.token_symbol,
        match_category: record.match_category,
        pool_address:   record.pool_address,
      })

      bus.emitSafe('ui_update', {
        type:           'wallet_action',
        action_type:    record.action_type,
        token_symbol:   record.token_symbol,
        match_category: record.match_category,
        pool_address:   record.pool_address,
      })
    } catch (e) {
      console.warn(`[Wallet] tx parse error ${sig.signature.slice(0, 8)}: ${e.message}`)
    }
  }

  if (found) console.log(`[Wallet] ${found} Meteora action(s) recorded`)
}

function start(walletAddress, rpcUrl, intervalMs) {
  if (_timer) return
  _walletAddr = walletAddress
  console.log(`[Wallet] Watching ${walletAddress.slice(0, 8)}… every ${intervalMs / 1000}s via ${rpcUrl}`)

  // Delay first poll so the rest of init finishes
  setTimeout(() => {
    pollOnce(walletAddress, rpcUrl).catch(e =>
      console.error('[Wallet] Initial poll failed:', e.message)
    )
    _timer = setInterval(() => {
      pollOnce(walletAddress, rpcUrl).catch(e =>
        console.error('[Wallet] Poll cycle failed:', e.message)
      )
    }, intervalMs)
  }, 5000)
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null }
}

function getStatus() {
  return {
    active:        !!_timer,
    walletAddress: _walletAddr,
    lastSignature: _lastSig,
  }
}

module.exports = { start, stop, getStatus, pollOnce }
