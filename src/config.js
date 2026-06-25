'use strict'
const fs = require('fs')
const path = require('path')

const USER_CONFIG_PATH = path.join(process.cwd(), 'user-config.json')

// These are Argus's core screening defaults — tuned conservatively.
// Override any value via user-config.json without touching this file.
const DEFAULTS = {
  screening: {
    // Market cap range — excludes micro-caps and large-caps
    minMcap: 50_000,
    maxMcap: 50_000_000,
    // Holder count — proxy for real distribution
    minHolders: 200,
    // Volume over the screening timeframe (USD)
    minVolume: 5_000,
    // TVL range (USD)
    minTvl: 5_000,
    maxTvl: null,
    // DLMM bin step range
    minBinStep: 20,
    maxBinStep: 200,
    // Fee/active-TVL ratio — core yield signal
    minFeeActiveTvlRatio: 0.01,
    // Organic score 0-100 (Jupiter/OKX). Base token / quote token.
    minOrganic: 30,
    minQuoteOrganic: 50,
    // Volatility cap (null = no cap)
    maxVolatility: 4.0,
    // Token age constraints (null = no constraint)
    minTokenAgeHours: null,
    maxTokenAgeHours: 72,
    // API params
    timeframe: '30m',
    category: 'all',
    excludeHighSupplyConcentration: true,
  },
  strategy: {
    // Spot LP is only deployed in the calm+moderate-yield zone.
    // Validated over 214 spot positions (84% win, worst −1.3%).
    spotMaxVolatility: 2,
    spotFeeTvlMin: 0.1,
    spotFeeTvlMax: 0.4,
  },
  limitOrder: {
    // Recommend LO when token has pulled back from ATH but isn't dead.
    maxPriceVsAthPct: 70,   // token must be ≤ 70% of ATH (some pullback)
    minPriceVsAthPct: 20,   // but not < 20% (potential dead token)
    maxVolatility: 2.0,      // low volatility preferred — stable base for LO entry
    minOrganic: 50,
    minHolders: 500,
    minTvl: 10_000,
  },
  scan: {
    topCandidateLimit: 10,
  },
  dryRun: {
    // Virtual stake per position (SOL)
    solAmount: 0.1,
    // Close conditions
    stopLossPct: 20,      // close if price drops > 20% from entry
    takeProfitPct: 50,    // close if price rises > 50% from entry
    maxHoldMinutes: 240,  // close after 4 hours regardless
  },
  wallet: {
    // Set your Solana wallet address in user-config.json to enable observation.
    // Argus will poll for on-chain Meteora DLMM actions every pollIntervalMs ms.
    address: null,
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    pollIntervalMs: 30_000,
    // Smart money wallets to track. Each entry: { address, label }
    // These wallets are observed as learning signals — their LP activity boosts
    // confidence when they enter the same pool Argus recommends.
    trackedWallets: [],
  },
  ai: {
    // LLM verdict generation via OpenAI-compatible endpoint.
    // Compatible with SumoPod, Ollama (default), LM Studio, etc.
    // Set enabled: true in user-config.json to activate.
    enabled: false,
    sumopodUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'llama3',
    maxTokens: 100,
    timeoutMs: 20_000,
  },
}

function deepMerge(base, override) {
  const result = { ...base }
  for (const [k, v] of Object.entries(override || {})) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = deepMerge(base[k] || {}, v)
    } else {
      result[k] = v
    }
  }
  return result
}

let _config = null

function getConfig() {
  if (_config) return _config
  let userConfig = {}
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf8'))
      console.log('[Config] user-config.json loaded')
    } catch (e) {
      console.warn('[Config] Cannot parse user-config.json:', e.message)
    }
  }
  _config = deepMerge(DEFAULTS, userConfig)
  return _config
}

function reloadConfig() {
  _config = null
  return getConfig()
}

module.exports = { getConfig, reloadConfig, DEFAULTS }
