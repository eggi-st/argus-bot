'use strict'
const patternUpdater = require('./pattern-updater')
const { getConfig } = require('../config')

function init() {
  patternUpdater.init()
  const n = getConfig().learning?.promotionThreshold ?? 60
  console.log(`[Learning] Pattern Library ready (promotes after N=${n} samples)`)
}

module.exports = { init }
