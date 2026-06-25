'use strict'
const { getConfig } = require('../config')
const observer = require('./observer')

function init() {
  const cfg  = getConfig()
  const wCfg = cfg.wallet || {}

  const wallets = []

  // Own wallet (type='own') — tracked for 'followed' decision matching
  if (wCfg.address) {
    wallets.push({ address: wCfg.address, label: 'own', type: 'own' })
  }

  // Smart money wallets — tracked as learning/confidence signals
  for (const tw of (wCfg.trackedWallets || [])) {
    if (!tw?.address) continue
    wallets.push({
      address: tw.address,
      label:   tw.label || tw.address.slice(0, 8),
      type:    'smart_money',
    })
  }

  if (!wallets.length) {
    console.log('[Wallet] Observer disabled — set wallet.address or wallet.trackedWallets in user-config.json')
    return
  }

  const rpcUrl     = wCfg.rpcUrl      || 'https://api.mainnet-beta.solana.com'
  const intervalMs = wCfg.pollIntervalMs ?? 30_000

  observer.start(wallets, rpcUrl, intervalMs)
}

module.exports = { init, observer }
