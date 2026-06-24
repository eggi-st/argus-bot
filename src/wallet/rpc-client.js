'use strict'
const { Connection, PublicKey } = require('@solana/web3.js')

let _conn = null
let _endpoint = null

function getConn(rpcUrl) {
  if (!_conn || _endpoint !== rpcUrl) {
    _conn = new Connection(rpcUrl, 'confirmed')
    _endpoint = rpcUrl
  }
  return _conn
}

async function getSignaturesForAddress(rpcUrl, address, opts = {}) {
  const conn = getConn(rpcUrl)
  const pubkey = new PublicKey(address)
  return conn.getSignaturesForAddress(pubkey, {
    limit: opts.limit ?? 20,
    ...(opts.until && { until: opts.until }),
  })
}

async function getParsedTransaction(rpcUrl, signature) {
  const conn = getConn(rpcUrl)
  return conn.getParsedTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
}

module.exports = { getSignaturesForAddress, getParsedTransaction }
