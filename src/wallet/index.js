'use strict'
const { getConfig } = require('../config')
const bus           = require('../core/event-bus')
const observer      = require('./observer')

let _rpcUrl = null

function loadDbWallets() {
  try {
    const db = require('../db/database')
    // Exclude retired wallets (inactive 14+d). cooling/stale are still worth watching.
    return db.prepare(`
      SELECT address, label, COALESCE(lifecycle_state, 'active') AS lifecycle_state,
             COALESCE(quality_score, 0.5) AS quality_score
      FROM tracked_wallets
      WHERE COALESCE(lifecycle_state, 'active') != 'retired'
    `).all().map(row => ({
      address:        row.address,
      label:          row.label || row.address.slice(0, 8),
      type:           'smart_money',
      lifecycleState: row.lifecycle_state,
      qualityScore:   row.quality_score,
    }))
  } catch { return [] }
}

function init() {
  const cfg  = getConfig()
  const wCfg = cfg.wallet || {}

  const wallets = []

  // Own wallet (type='own') — tracked for 'followed' decision matching
  if (wCfg.address) {
    wallets.push({ address: wCfg.address, label: 'own', type: 'own' })
  }

  // Static smart money from user-config.json
  for (const tw of (wCfg.trackedWallets || [])) {
    if (!tw?.address) continue
    wallets.push({ address: tw.address, label: tw.label || tw.address.slice(0, 8), type: 'smart_money' })
  }

  // Dynamic smart money from Hivemind DB
  for (const tw of loadDbWallets()) {
    if (!wallets.some(w => w.address === tw.address)) wallets.push(tw)
  }

  _rpcUrl = wCfg.rpcUrl || 'https://api.mainnet-beta.solana.com'
  const intervalMs = wCfg.pollIntervalMs ?? 30_000

  if (!wallets.length) {
    console.log('[Wallet] Observer disabled — set wallet.address or wallet.trackedWallets in user-config.json')
    return
  }

  observer.start(wallets, _rpcUrl, intervalMs)

  // Hot-add newly discovered wallets without restarting observer
  bus.onSlow('tracked_wallets_updated', () => {
    for (const w of loadDbWallets()) {
      observer.addWallet(w)
    }
  })
}

module.exports = { init, observer }
