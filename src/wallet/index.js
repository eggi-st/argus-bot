'use strict'
const { getConfig } = require('../config')
const observer = require('./observer')

function init() {
  const cfg = getConfig()
  const wCfg = cfg.wallet || {}

  if (!wCfg.address) {
    console.log('[Wallet] Observer disabled — set wallet.address in user-config.json to enable')
    return
  }

  const rpcUrl     = wCfg.rpcUrl      || 'https://api.mainnet-beta.solana.com'
  const intervalMs = wCfg.pollIntervalMs ?? 30_000

  observer.start(wCfg.address, rpcUrl, intervalMs)
}

module.exports = { init, observer }
