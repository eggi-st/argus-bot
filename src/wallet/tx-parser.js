'use strict'

const METEORA_DLMM_PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'

function classifyAction(logs) {
  for (const log of logs) {
    if (log.includes('Instruction: AddLiquidity'))     return 'add_liquidity'
    if (log.includes('Instruction: RemoveLiquidity'))  return 'remove_liquidity'
    if (log.includes('Instruction: ClaimFee'))         return 'claim_fees'
    if (log.includes('Instruction: InitializeLbPair')) return 'open_position'
    if (log.includes('Instruction: CloseLbPair'))      return 'close_position'
  }
  return null  // unrecognized instruction (swap, update, etc.) — caller should discard
}

function pubkeyStr(k) {
  if (!k) return null
  if (typeof k === 'string') return k
  if (k.toBase58) return k.toBase58()
  if (k.toString) return k.toString()
  return null
}

/**
 * Parse a getParsedTransaction result for Meteora DLMM activity.
 * Returns null if the transaction has no Meteora involvement.
 */
function parseMeteoraTx(txResult, signature) {
  if (!txResult || txResult.meta?.err) return null

  const logs = txResult.meta?.logMessages || []
  if (!logs.some(l => l.includes(METEORA_DLMM_PROGRAM))) return null

  const actionType = classifyAction(logs)
  if (!actionType) return null  // not a tracked Meteora action (swap, update, etc.)

  // Collect all account keys from the transaction
  const rawKeys = txResult.transaction?.message?.accountKeys || []
  const allAccounts = rawKeys.map(k =>
    // getParsedTransaction returns { pubkey, signer, writable } objects
    pubkeyStr(k?.pubkey ?? k)
  ).filter(Boolean)

  // Collect accounts specifically from Meteora instructions (outer)
  const outerInstrs = txResult.transaction?.message?.instructions || []
  const meteoraAccounts = []
  for (const instr of outerInstrs) {
    const progId = pubkeyStr(instr.programId)
    if (progId !== METEORA_DLMM_PROGRAM) continue
    if (Array.isArray(instr.accounts)) {
      for (const a of instr.accounts) meteoraAccounts.push(pubkeyStr(a))
    }
  }

  // Also check inner instructions (Meteora often called via CPI)
  for (const group of txResult.meta?.innerInstructions || []) {
    for (const instr of group.instructions || []) {
      const progId = pubkeyStr(instr.programId)
      if (progId !== METEORA_DLMM_PROGRAM) continue
      if (Array.isArray(instr.accounts)) {
        for (const a of instr.accounts) meteoraAccounts.push(pubkeyStr(a))
      }
    }
  }

  // Use Meteora-specific accounts if found; fall back to all accounts
  const involvedAccounts = [...new Set(
    (meteoraAccounts.filter(Boolean).length ? meteoraAccounts : allAccounts).filter(Boolean)
  )]

  const blockTime = txResult.blockTime
    ? new Date(txResult.blockTime * 1000).toISOString()
    : new Date().toISOString()

  // Net SOL movement of the fee payer (accountKeys[0]). For a wallet acting on its
  // OWN position the fee payer IS that wallet, so this ≈ the SOL it moved:
  //   add_liquidity → negative (SOL out), remove/claim → positive (SOL in).
  // Approximate (includes tx fee + WSOL rent), but enough to size each action.
  const pre = txResult.meta?.preBalances
  const post = txResult.meta?.postBalances
  let solDelta = null
  if (Array.isArray(pre) && Array.isArray(post) && pre.length && post.length) {
    solDelta = Math.round(((post[0] - pre[0]) / 1e9) * 1000) / 1000
  }

  return {
    signature,
    actionType,
    involvedAccounts,
    allAccounts,
    blockTime,
    solDelta,
  }
}

module.exports = { parseMeteoraTx, METEORA_DLMM_PROGRAM }
