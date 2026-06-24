'use strict'
const patternUpdater = require('./pattern-updater')

function init() {
  patternUpdater.init()
  console.log('[Learning] Pattern Library ready (promotes after N=20 samples)')
}

module.exports = { init }
