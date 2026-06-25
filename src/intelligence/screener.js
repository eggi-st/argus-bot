'use strict'
const fetch = require('node-fetch')
const db = require('../db/database')
const { getConfig } = require('../config')
const { recordRejection } = require('../db/schema')

const POOL_DISCOVERY_BASE = 'https://pool-discovery-api.datapi.meteora.ag'
const OKX_BASE = 'https://web3.okx.com'
const OKX_CHAIN = '501'  // Solana
const OKX_HEADERS = { 'Ok-Access-Client-type': 'agent-cli' }
const FETCH_TIMEOUT_MS = 15_000
const OKX_TIMEOUT_MS = 8_000

// Meteora pool discovery API only accepts timeframes >= 30m for volatility
const MIN_VOL_TF = '30m'
const TF_MINUTES = { '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '12h': 720, '24h': 1440 }

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(tag, msg) { console.log(`[${tag}] ${msg}`) }
function num(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null }
function round(n) { return n != null ? Math.round(n) : null }
function fix(n, d) { const v = Number(n); return Number.isFinite(v) ? Number(v.toFixed(d)) : null }
function normalizeSymbol(s) { return String(s || '').trim().toUpperCase() }
function getBaseMint(pool) { return pool?.token_x?.address || pool?.base_token_address || pool?.base_mint || null }
function getPoolLaunchpad(pool) { return pool?.token_x?.launchpad || pool?.base_token_launchpad || pool?.launchpad || null }

function getVolatilityTf(sourceTf) {
  const srcMin = TF_MINUTES[sourceTf]
  const minMin = TF_MINUTES[MIN_VOL_TF]
  return srcMin != null && srcMin >= minMin ? sourceTf : MIN_VOL_TF
}

function isUsableVolatility(v) { const n = Number(v); return Number.isFinite(n) && n > 0 }

function isTokenBlacklisted(mint) {
  if (!mint) return false
  try {
    return !!db.prepare(`SELECT 1 FROM blacklist WHERE type='token' AND value=? LIMIT 1`).get(mint)
  } catch { return false }
}

function isDeployerBlacklisted(address) {
  if (!address) return false
  try {
    return !!db.prepare(`SELECT 1 FROM blacklist WHERE type='deployer' AND value=? LIMIT 1`).get(address)
  } catch { return false }
}

function scoreCandidate(pool) {
  return (pool.fee_active_tvl_ratio || 0) * 1000
    + (pool.organic_score || 0) * 10
    + (pool.volume_window || 0) / 100
    + (pool.holders || 0) / 100
}

// ── Pool Discovery API ────────────────────────────────────────────────────────

async function fetchDiscoveryPage({ page_size, filters, timeframe, category }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=${page_size}` +
    `&filter_by=${encodeURIComponent(filters)}&timeframe=${timeframe}&category=${category}`
  const res = await fetch(url, { timeout: FETCH_TIMEOUT_MS })
  if (!res.ok) throw new Error(`Pool Discovery API ${res.status} ${res.statusText}`)
  return res.json()
}

async function fetchPoolDetail({ poolAddress, timeframe }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${timeframe}`
  const res = await fetch(url, { timeout: FETCH_TIMEOUT_MS })
  if (!res.ok) throw new Error(`Pool detail API ${res.status}`)
  const data = await res.json()
  return (data.data || [])[0] ?? null
}

async function applyVolatilityTf(rawPools, sourceTf) {
  const targetTf = getVolatilityTf(sourceTf)
  if (sourceTf === targetTf) {
    rawPools.forEach(p => p && (p.volatility_timeframe = targetTf))
    return rawPools
  }
  const addrs = [...new Set(rawPools.map(p => p?.pool_address).filter(Boolean))]
  const results = await Promise.allSettled(
    addrs.map(a =>
      fetchPoolDetail({ poolAddress: a, timeframe: targetTf })
        .then(p => ({ addr: a, volatility: num(p?.volatility) }))
    )
  )
  const byPool = new Map()
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.volatility != null)
      byPool.set(r.value.addr, r.value.volatility)
  }
  for (const p of rawPools) {
    if (p?.pool_address && byPool.has(p.pool_address)) {
      p.volatility = byPool.get(p.pool_address)
      p.volatility_timeframe = targetTf
    }
  }
  return rawPools
}

// ── OKX Enrichment ───────────────────────────────────────────────────────────

async function okxGet(path) {
  const res = await fetch(`${OKX_BASE}${path}`, { headers: OKX_HEADERS, timeout: OKX_TIMEOUT_MS })
  if (!res.ok) throw new Error(`OKX GET ${res.status}: ${path}`)
  const json = await res.json()
  if (json.code !== '0' && json.code !== 0) throw new Error(`OKX error ${json.code}: ${json.msg || 'unknown'}`)
  return json.data
}

async function okxPost(path, body) {
  const res = await fetch(`${OKX_BASE}${path}`, {
    method: 'POST',
    headers: { ...OKX_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: OKX_TIMEOUT_MS,
  })
  if (!res.ok) throw new Error(`OKX POST ${res.status}: ${path}`)
  const json = await res.json()
  if (json.code !== '0' && json.code !== 0) throw new Error(`OKX error ${json.code}: ${json.msg || 'unknown'}`)
  return json.data
}

async function getOkxAdvancedInfo(mint) {
  const data = await okxGet(
    `/api/v6/dex/market/token/advanced-info?chainIndex=${OKX_CHAIN}&tokenContractAddress=${mint}`
  )
  const d = Array.isArray(data) ? data[0] : data
  if (!d) return null
  const tags = d.tokenTags || []
  return {
    risk_level: num(d.riskControlLevel),
    bundle_pct: num(d.bundleHoldingPercent),
    sniper_pct: num(d.sniperHoldingPercent),
    top10_pct: num(d.top10HoldPercent),
    dev_holding_pct: num(d.devHoldingPercent),
    creator: d.creatorAddress || null,
    smart_money_buy: tags.includes('smartMoneyBuy'),
    dev_sold_all: tags.includes('devHoldingStatusSellAll'),
    is_honeypot: tags.includes('honeypot'),
    dex_boost: tags.includes('dexBoost'),
    tags,
  }
}

async function getOkxPriceInfo(mint) {
  const data = await okxPost('/api/v6/dex/market/price-info', [
    { chainIndex: OKX_CHAIN, tokenContractAddress: mint },
  ])
  const d = Array.isArray(data) ? data[0] : data
  if (!d) return null
  const price = parseFloat(d.price || 0)
  const maxPrice = parseFloat(d.maxPrice || 0)
  return {
    price,
    ath: maxPrice,
    price_vs_ath_pct: maxPrice > 0 ? fix((price / maxPrice) * 100, 1) : null,
    holders: num(d.holders),
    market_cap: num(d.marketCap),
  }
}

async function getOkxRiskFlags(mint) {
  const ts = Date.now()
  const data = await okxGet(
    `/priapi/v1/dx/market/v2/risk/new/check?chainId=${OKX_CHAIN}&tokenContractAddress=${mint}&t=${ts}`
  )
  const allEntries = [
    ...((data?.allAnalysis?.highRiskList || [])),
    ...((data?.allAnalysis?.middleRiskList || [])),
    ...((data?.swapAnalysis?.highRiskList || [])),
    ...((data?.contractAnalysis?.highRiskList || [])),
  ]
  const hasRisk = key =>
    allEntries.some(e => e?.riskKey === key &&
      typeof e?.newRiskLabel === 'string' &&
      e.newRiskLabel.trim().toLowerCase() === 'yes')
  return {
    is_rugpull: hasRisk('isLiquidityRemoval'),
    is_wash: hasRisk('isWash'),
  }
}

async function enrichWithOkx(pools) {
  const results = await Promise.allSettled(
    pools.map(async p => {
      if (!p.base?.mint) return {}
      const [adv, price, risk] = await Promise.allSettled([
        getOkxAdvancedInfo(p.base.mint),
        getOkxPriceInfo(p.base.mint),
        getOkxRiskFlags(p.base.mint),
      ])
      return {
        adv: adv.status === 'fulfilled' ? adv.value : null,
        price: price.status === 'fulfilled' ? price.value : null,
        risk: risk.status === 'fulfilled' ? risk.value : null,
      }
    })
  )

  let okxCalls = 0, advFail = 0, priceFail = 0, riskFail = 0
  for (let i = 0; i < pools.length; i++) {
    const r = results[i]
    if (r.status !== 'fulfilled') continue
    const { adv, price, risk } = r.value
    const p = pools[i]
    okxCalls++
    if (adv) {
      p.risk_level = adv.risk_level
      p.bundle_pct = adv.bundle_pct
      p.sniper_pct = adv.sniper_pct
      p.top10_pct = adv.top10_pct
      p.smart_money_buy = adv.smart_money_buy
      p.dev_sold_all = adv.dev_sold_all
      p.is_honeypot = adv.is_honeypot
      p.dex_boost = adv.dex_boost
      if (adv.creator && !p.dev) p.dev = adv.creator
    } else advFail++
    if (price) {
      p.price_vs_ath_pct = price.price_vs_ath_pct
      p.ath = price.ath
      if (price.holders != null && p.holders == null) p.holders = price.holders
    } else priceFail++
    if (risk) {
      p.is_rugpull = risk.is_rugpull
      p.is_wash = risk.is_wash
    } else riskFail++
  }
  // Surface silent OKX throttling/timeouts (Promise.allSettled swallows them otherwise)
  log('screener', `OKX enriched ${okxCalls}/${pools.length} pool(s) — sub-call fails: adv=${advFail} price=${priceFail} risk=${riskFail}`)
}

// ── Hard reject reasons ────────────────────────────────────────────────────────

function getRejectReason(pool, s) {
  const base = pool?.token_x || {}
  const quote = pool?.token_y || {}
  const quoteSymbol = normalizeSymbol(quote?.symbol)

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true)
    return 'high supply concentration'
  if (pool?.base_token_has_critical_warnings === true) return 'base token critical warnings'
  if (pool?.quote_token_has_critical_warnings === true) return 'quote token critical warnings'
  if (pool?.base_token_has_high_single_ownership === true) return 'high single ownership'
  if (pool?.pool_type && pool.pool_type !== 'dlmm') return `not dlmm (${pool.pool_type})`
  if (quoteSymbol !== 'SOL' && quoteSymbol !== 'WSOL') return `quote=${quote?.symbol || '?'} (not SOL)`

  const binStep = num(pool?.dlmm_params?.bin_step)
  const tvl = num(pool?.tvl ?? pool?.active_tvl)
  const feeRatio = num(pool?.fee_active_tvl_ratio)
  const volatility = num(pool?.volatility)
  const volume = num(pool?.volume)
  const holders = num(pool?.base_token_holders)
  const mcap = num(base?.market_cap)
  const baseOrganic = num(base?.organic_score)
  const quoteOrganic = num(quote?.organic_score)
  const createdAt = num(base?.created_at)

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? '?'} < ${s.minMcap}`
  if (mcap > s.maxMcap) return `mcap ${mcap} > ${s.maxMcap}`
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? '?'} < ${s.minHolders}`
  if (volume != null && volume < s.minVolume) return `volume ${volume} < ${s.minVolume}`
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? '?'} < ${s.minTvl}`
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} > ${s.maxTvl}`
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? '?'} < ${s.minBinStep}`
  if (binStep > s.maxBinStep) return `bin_step ${binStep} > ${s.maxBinStep}`
  if (feeRatio == null || feeRatio < s.minFeeActiveTvlRatio)
    return `fee/tvl ${feeRatio ?? '?'} < ${s.minFeeActiveTvlRatio}`
  if (!isUsableVolatility(volatility)) return `unusable volatility (${volatility ?? '?'})`
  if (s.maxVolatility != null && volatility > s.maxVolatility)
    return `volatility ${(+volatility).toFixed(2)} > ${s.maxVolatility}`
  if (baseOrganic == null || baseOrganic < s.minOrganic)
    return `base organic ${baseOrganic ?? '?'} < ${s.minOrganic}`
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic)
    return `quote organic ${quoteOrganic ?? '?'} < ${s.minQuoteOrganic}`
  if (s.minTokenAgeHours != null) {
    const maxCreated = Date.now() - s.minTokenAgeHours * 3_600_000
    if (createdAt == null || createdAt > maxCreated) return `token age < ${s.minTokenAgeHours}h`
  }
  if (s.maxTokenAgeHours != null) {
    const minCreated = Date.now() - s.maxTokenAgeHours * 3_600_000
    if (createdAt == null || createdAt < minCreated) return `token age > ${s.maxTokenAgeHours}h`
  }
  return null
}

// ── Pool condensing ───────────────────────────────────────────────────────────

function condensePool(p, volatilityTf) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
    },
    quote: { symbol: p.token_y?.symbol },
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || volatilityTf,
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    volume_change_pct: fix(p.volume_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch pools from Meteora Pool Discovery, apply screening filters.
 * Returns { pools, total, filtered_examples }
 */
async function discoverPools({ page_size = 50, screening } = {}) {
  const s = screening || getConfig().screening
  const targetTf = getVolatilityTf(s.timeframe)

  const filters = [
    'base_token_has_critical_warnings=false',
    'quote_token_has_critical_warnings=false',
    s.excludeHighSupplyConcentration ? 'base_token_has_high_supply_concentration=false' : null,
    'base_token_has_high_single_ownership=false',
    'pool_type=dlmm',
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
  ].filter(Boolean).join('&&')

  const apiTf = (TF_MINUTES[s.timeframe] ?? 0) >= TF_MINUTES[MIN_VOL_TF] ? s.timeframe : MIN_VOL_TF
  const data = await fetchDiscoveryPage({ page_size, filters, timeframe: apiTf, category: s.category })
  let rawPools = Array.isArray(data.data) ? data.data : []

  rawPools = await applyVolatilityTf(rawPools, s.timeframe)

  const filteredExamples = []
  const scanTime = new Date().toISOString()
  const passed = rawPools.filter(pool => {
    const reason = getRejectReason(pool, s)
    if (reason) {
      filteredExamples.push({ name: pool.name || '?', reason })
      try {
        recordRejection({
          scanned_at:   scanTime,
          pool_address: pool.pool_address,
          token_symbol: pool.token_x?.symbol || null,
          token_mint:   getBaseMint(pool),
          reject_stage: 'screener',
          reason,
          key_metrics:  JSON.stringify({
            vol:     pool.volatility,
            fee_tvl: pool.fee_active_tvl_ratio,
            organic: pool.token_x?.organic_score,
            holders: pool.base_token_holders,
            tvl:     pool.tvl,
            mcap:    pool.token_x?.market_cap,
          }),
        })
      } catch {}
      return false
    }
    const mint = getBaseMint(pool)
    if (isTokenBlacklisted(mint)) {
      filteredExamples.push({ name: pool.name || '?', reason: 'blacklisted token' })
      try {
        recordRejection({
          scanned_at: scanTime, pool_address: pool.pool_address,
          token_symbol: pool.token_x?.symbol || null, token_mint: mint,
          reject_stage: 'screener', reason: 'blacklisted token', key_metrics: null,
        })
      } catch {}
      return false
    }
    return true
  })

  return {
    total: data.total,
    pools: passed.map(p => condensePool(p, targetTf)),
    filtered_examples: filteredExamples,
  }
}

/**
 * Get top screened candidates with OKX enrichment applied.
 * Returns { candidates, total_screened, filtered_examples }
 */
async function getTopCandidates({ limit = 10, screening } = {}) {
  const discovery = await discoverPools({ page_size: 50, screening })
  const { pools, total, filtered_examples } = discovery

  // Deduplicate by base mint, sort by score, enrich only the top (limit + small buffer).
  // Buffer covers the few that post-enrichment hard filters (wash/rug/honeypot) will drop,
  // so we still land ~limit candidates without tripling OKX load per pipeline.
  const seen = new Set()
  const deduped = pools
    .filter(p => {
      if (!p.base?.mint) return true
      if (seen.has(p.base.mint)) return false
      seen.add(p.base.mint)
      return true
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, limit + 5)

  // OKX enrichment (parallel)
  if (deduped.length > 0) {
    await enrichWithOkx(deduped)
  }

  const now = new Date().toISOString()

  // Post-enrichment hard filters + rejection log
  const clean = deduped.filter(p => {
    let rejectReason = null
    if (p.is_wash)                       rejectReason = 'wash trading flagged'
    else if (p.is_rugpull)               rejectReason = 'rugpull flagged'
    else if (p.is_honeypot)              rejectReason = 'honeypot flagged'
    else if (isDeployerBlacklisted(p.dev)) rejectReason = 'blocked deployer'

    if (rejectReason) {
      log('screener', `Drop ${rejectReason}: ${p.name}`)
      filtered_examples.push({ name: p.name || '?', reason: rejectReason })
      try {
        recordRejection({
          scanned_at:   now,
          pool_address: p.pool,
          token_symbol: p.base?.symbol || null,
          token_mint:   p.base?.mint   || null,
          reject_stage: 'enrichment',
          reason:       rejectReason,
          key_metrics:  JSON.stringify({
            vol: p.volatility, fee_tvl: p.fee_active_tvl_ratio,
            organic: p.organic_score, holders: p.holders,
          }),
        })
      } catch {}
      return false
    }
    return true
  })

  const candidates = clean.slice(0, limit)

  if (candidates.length > 0) {
    const lines = candidates.map((p, i) => {
      const feeTvlStr = p.fee_active_tvl_ratio != null
        ? `${(p.fee_active_tvl_ratio * 100).toFixed(1)}%`.padStart(6) : '     ?'
      const athStr = p.price_vs_ath_pct != null ? `${p.price_vs_ath_pct}%` : '?'
      return `  #${i + 1}  ${(p.name || '?').padEnd(20)} fee/tvl:${feeTvlStr}  org:${String(p.organic_score ?? '?').padStart(3)}  ath:${athStr.padStart(6)}`
    })
    log('screener', `${candidates.length} candidate(s) passed:\n${lines.join('\n')}`)
  } else {
    log('screener', 'No candidates passed all filters this cycle')
  }

  return { candidates, total_screened: total, filtered_examples: filtered_examples.slice(0, 5) }
}

module.exports = { discoverPools, getTopCandidates }
