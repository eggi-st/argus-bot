'use strict'
const bus = require('../core/event-bus')
const { getSignaturesForAddress, getParsedTransaction } = require('./rpc-client')
const { parseMeteoraTx } = require('./tx-parser')
const { processAction } = require('./matcher')
const { recordWalletAction, markFollowed } = require('../db/schema')

let _timer   = null
let _cursors = new Map()   // address → lastSig
let _wallets = []          // [{address, label, type}]

/**
 * Poll a single wallet for new Meteora transactions.
 */
async function pollWallet(wallet, rpcUrl) {
  const lastSig = _cursors.get(wallet.address) || null
  let sigs
  try {
    sigs = await getSignaturesForAddress(rpcUrl, wallet.address, {
      limit: 20,
      until: lastSig || undefined,
    })
  } catch (e) {
    console.warn(`[Wallet] ${wallet.label}: getSignaturesForAddress error: ${e.message}`)
    return
  }

  if (!sigs?.length) return

  const newest = sigs[0].signature

  // First run: initialize cursor, don't process historical transactions
  if (!lastSig) {
    _cursors.set(wallet.address, newest)
    console.log(`[Wallet] ${wallet.label} (${wallet.type}): cursor initialized at ${newest.slice(0, 8)}…`)
    return
  }

  _cursors.set(wallet.address, newest)

  const fresh = sigs.filter(s => !s.err)
  if (!fresh.length) return

  let found = 0
  for (const sig of fresh) {
    try {
      const txResult = await getParsedTransaction(rpcUrl, sig.signature)
      const action = parseMeteoraTx(txResult, sig.signature)
      if (!action) continue

      const record = await processAction(action, wallet, { recordWalletAction, markFollowed })
      found++

      bus.emitSafe('wallet_action_detected', {
        action_type:    record.action_type,
        token_symbol:   record.token_symbol,
        match_category: record.match_category,
        pool_address:   record.pool_address,
        wallet_type:    wallet.type,
        wallet_label:   wallet.label,
      })

      bus.emitSafe('ui_update', {
        type:           'wallet_action',
        action_type:    record.action_type,
        token_symbol:   record.token_symbol,
        match_category: record.match_category,
        pool_address:   record.pool_address,
        wallet_type:    wallet.type,
        wallet_label:   wallet.label,
      })
    } catch (e) {
      console.warn(`[Wallet] ${wallet.label}: parse error ${sig.signature.slice(0, 8)}: ${e.message}`)
    }
  }

  if (found) console.log(`[Wallet] ${wallet.label}: ${found} Meteora action(s) recorded`)
}

/**
 * Poll all wallets sequentially (avoids rate-limiting on shared RPC).
 */
async function pollAll(wallets, rpcUrl) {
  for (const wallet of wallets) {
    await pollWallet(wallet, rpcUrl)
  }
}

function start(wallets, rpcUrl, intervalMs) {
  if (_timer) return
  _wallets = wallets

  const own = wallets.filter(w => w.type === 'own').length
  const sm  = wallets.filter(w => w.type === 'smart_money').length
  console.log(`[Wallet] Watching ${wallets.length} wallet(s) every ${intervalMs / 1000}s (${own} own · ${sm} smart money)`)
  for (const w of wallets) {
    const icon = w.type === 'smart_money' ? '🐋' : '👤'
    console.log(`[Wallet]   ${icon} ${w.label}: ${w.address.slice(0, 8)}…`)
  }

  setTimeout(() => {
    pollAll(wallets, rpcUrl).catch(e => console.error('[Wallet] Initial poll failed:', e.message))
    _timer = setInterval(() => {
      pollAll(wallets, rpcUrl).catch(e => console.error('[Wallet] Poll cycle failed:', e.message))
    }, intervalMs)
  }, 5000)
}

/**
 * Dynamically add a newly discovered wallet without restarting the observer.
 * Cursor will be initialized on the next poll cycle.
 */
function addWallet(wallet) {
  if (!_timer) return  // observer not running
  if (_wallets.some(w => w.address === wallet.address)) return  // already tracked
  _wallets.push(wallet)
  const icon = wallet.type === 'smart_money' ? '🐋' : '👤'
  console.log(`[Wallet] ${icon} Hot-added: ${wallet.label} (${wallet.address.slice(0, 8)}…)`)
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null }
}

function getStatus() {
  return {
    active:  !!_timer,
    wallets: _wallets.map(w => ({
      address:       w.address,
      label:         w.label,
      type:          w.type,
      lastSignature: _cursors.get(w.address) || null,
    })),
  }
}

module.exports = { start, stop, getStatus, pollWallet, addWallet }
