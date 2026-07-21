'use strict'
const bus = require('../core/event-bus')
const { getSignaturesForAddress, getParsedTransaction } = require('./rpc-client')
const { parseMeteoraTx } = require('./tx-parser')
const { processAction } = require('./matcher')
const { recordWalletAction, markFollowed } = require('../db/schema')

let _timer        = null
let _cursors      = new Map()   // address → lastSig
let _wallets      = []          // [{address, label, type}]
let _rpcUrls      = []          // [primary, ...fallbacks]
let _maxFailed    = 5           // consecutive all-error cycles before alerting
let _failedCycles = 0           // consecutive cycles where every RPC call errored
let _alertedDown  = false       // one-shot guard so we alert once, not every cycle
let _polling      = false       // re-entrancy guard: skip a tick if the previous still runs

/**
 * Poll a single wallet for new Meteora transactions.
 * Returns 'rpc_error' when the signature fetch failed on every endpoint,
 * 'ok' otherwise (including "no new activity") — the caller uses this to tell a
 * genuine outage apart from a quiet market when tracking observer health.
 */
async function pollWallet(wallet, rpcUrls) {
  const lastSig = _cursors.get(wallet.address) || null
  let sigs
  try {
    sigs = await getSignaturesForAddress(rpcUrls, wallet.address, {
      limit: 20,
      until: lastSig || undefined,
    })
  } catch (e) {
    console.warn(`[Wallet] ${wallet.label}: getSignaturesForAddress error (all endpoints): ${e.message}`)
    return 'rpc_error'
  }

  if (!sigs?.length) return 'ok'

  const newest = sigs[0].signature

  // First run: initialize cursor, don't process historical transactions
  if (!lastSig) {
    _cursors.set(wallet.address, newest)
    console.log(`[Wallet] ${wallet.label} (${wallet.type}): cursor initialized at ${newest.slice(0, 8)}…`)
    return 'ok'
  }

  _cursors.set(wallet.address, newest)

  const fresh = sigs.filter(s => !s.err)
  if (!fresh.length) return 'ok'

  let found = 0
  for (const sig of fresh) {
    try {
      const txResult = await getParsedTransaction(rpcUrls, sig.signature)
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

  if (found) {
    console.log(`[Wallet] ${wallet.label}: ${found} Meteora action(s) recorded`)
    // Activity signal: this wallet is still alive — reset lifecycle to 'active'.
    if (wallet.type === 'smart_money') {
      try {
        const db = require('../db/database')
        db.prepare(`
          UPDATE tracked_wallets
          SET last_seen = ?, lifecycle_state = 'active', active = 1
          WHERE address = ?
        `).run(new Date().toISOString(), wallet.address)
      } catch { /* non-critical */ }
    }
  }
  return 'ok'
}

/**
 * Poll all wallets sequentially (avoids rate-limiting on shared RPC), then update
 * observer-health state. A cycle is a FAILURE only when every wallet's RPC call
 * errored on all endpoints — "no activity" is healthy. After _maxFailed consecutive
 * failed cycles a one-shot P1 alert fires; the next healthy cycle clears it.
 */
async function pollAll(wallets, rpcUrls) {
  let errored = 0
  for (const wallet of wallets) {
    if ((await pollWallet(wallet, rpcUrls)) === 'rpc_error') errored++
  }

  const allErrored = wallets.length > 0 && errored === wallets.length
  if (allErrored) {
    _failedCycles++
    // Re-fire every _maxFailed cycles while down (not a pure one-shot) so the P1 alert isn't
    // lost forever if Telegram was also unreachable during the outage that triggered it.
    if (_failedCycles >= _maxFailed && (_failedCycles - _maxFailed) % _maxFailed === 0) {
      _alertedDown = true
      console.error(`[Wallet] Observer DOWN: ${_failedCycles} consecutive all-RPC-error cycles across ${wallets.length} wallet(s)`)
      bus.emitSafe('wallet_observer_down', { failedCycles: _failedCycles, wallets: wallets.length })
    }
  } else {
    if (_alertedDown) {
      console.log('[Wallet] Observer recovered — RPC responding again')
      bus.emitSafe('wallet_observer_recovered', { afterFailedCycles: _failedCycles })
    }
    _failedCycles = 0
    _alertedDown  = false
  }
}

function start(wallets, rpcUrls, intervalMs, opts = {}) {
  if (_timer) return
  _wallets   = wallets
  _rpcUrls   = Array.isArray(rpcUrls) ? rpcUrls.filter(Boolean) : [rpcUrls].filter(Boolean)
  _maxFailed = opts.healthMaxFailedCycles ?? 5

  const own = wallets.filter(w => w.type === 'own').length
  const sm  = wallets.filter(w => w.type === 'smart_money').length
  console.log(`[Wallet] Watching ${wallets.length} wallet(s) every ${intervalMs / 1000}s (${own} own · ${sm} smart money)`)
  for (const w of wallets) {
    const icon = w.type === 'smart_money' ? '🐋' : '👤'
    console.log(`[Wallet]   ${icon} ${w.label}: ${w.address.slice(0, 8)}…`)
  }

  // Re-entrancy guard: with per-call RPC timeouts a cycle is bounded, but if a slow cycle
  // ever runs past intervalMs we skip the overlapping tick instead of piling up concurrent
  // pollAll runs that mutate the shared _cursors map.
  const tick = () => {
    if (_polling) { console.warn('[Wallet] Previous poll cycle still running — skipping tick'); return }
    _polling = true
    pollAll(_wallets, _rpcUrls)
      .catch(e => console.error('[Wallet] Poll cycle failed:', e.message))
      .finally(() => { _polling = false })
  }

  setTimeout(() => {
    tick()
    _timer = setInterval(tick, intervalMs)
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
    active:       !!_timer,
    failedCycles: _failedCycles,
    down:         _alertedDown,
    endpoints:    _rpcUrls.length,
    wallets: _wallets.map(w => ({
      address:       w.address,
      label:         w.label,
      type:          w.type,
      lastSignature: _cursors.get(w.address) || null,
    })),
  }
}

module.exports = { start, stop, getStatus, pollWallet, addWallet }
