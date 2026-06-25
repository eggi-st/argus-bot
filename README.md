# 🦅 Argus — DLMM Intelligence Assistant

**Argus** is a standalone intelligence assistant for [Meteora DLMM](https://app.meteora.ag) liquidity pools on Solana. It screens pools, recommends LP strategies, tracks outcomes with a dry-run engine, and learns from its own performance over time.

> **Argus does NOT auto-execute.** It recommends — you decide. Optionally, it can feed signals to [Meridian](https://github.com/eggi-st/meridian-bot) for automated execution.

---

## Contents

- [What Argus Does](#what-argus-does)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Features](#features)
- [Web UI](#web-ui)
- [Telegram Alerts](#telegram-alerts)
- [Meridian Integration](#meridian-integration)
- [Hivemind — Smart Money Discovery](#hivemind--smart-money-discovery)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

---

## What Argus Does

Every 15 minutes, Argus:

1. **Screens** top Meteora DLMM pools via Pool Discovery API + OKX safety signals
2. **Routes** each pool to the best strategy (Spot LP / Bid-Ask / Limit Order)
3. **Records** a dry-run position to paper-trade the recommendation
4. **Asks an LLM** for a brief narrative verdict (optional, if AI configured)
5. **Alerts** you via Telegram with the recommendation + confidence score
6. **Tracks** outcomes: when the dry-run closes, feeds P&L into the Pattern Library
7. **Learns**: Pattern Library adjusts confidence scores based on historical win rates

In parallel, the **Wallet Observer** watches your on-chain wallet and tracked smart money wallets every 30 seconds. The **Hivemind Discovery** system finds new smart money wallets automatically from 5 sources every 6 hours.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                     ARGUS                           │
│                                                     │
│  ┌──────────┐   ┌──────────────┐   ┌─────────────┐ │
│  │ Screener │──▶│  IC / Router │──▶│  Dry Run    │ │
│  │ (Meteora │   │  (strategy + │   │  Engine     │ │
│  │  + OKX)  │   │  confidence) │   │  (P&L sim)  │ │
│  └──────────┘   └──────────────┘   └──────┬──────┘ │
│                        │                  │         │
│                        ▼                  ▼         │
│                 ┌─────────────┐   ┌─────────────┐  │
│                 │  Pattern    │   │   Outcome   │  │
│                 │  Library    │◀──│   Recorder  │  │
│                 │  (win rate) │   └─────────────┘  │
│                 └─────────────┘                     │
│                                                     │
│  ┌──────────────────┐   ┌────────────────────────┐  │
│  │ Wallet Observer  │   │  Hivemind Discovery    │  │
│  │ (own + smart $)  │   │  (5-source fallback)   │  │
│  └──────────────────┘   └────────────────────────┘  │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ Telegram │  │ Web UI   │  │ Meridian API      │  │
│  │ Alerts   │  │ Dashboard│  │ (push/pull feed)  │  │
│  └──────────┘  └──────────┘  └───────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Event-driven internals:** All components communicate via a typed Event Bus (fast path for UI, slow path for DB writes). No shared mutable state — RiskState is the single synchronous gate.

---

## Quick Start

### Prerequisites

- **Node.js** ≥ 18.0.0
- **Git**
- **Telegram bot token** (from [@BotFather](https://t.me/BotFather)) — optional but recommended
- A Solana **RPC endpoint** (public: `https://api.mainnet-beta.solana.com`, or Helius free tier)

### Installation

```bash
git clone https://github.com/eggi-st/argus-bot.git
cd argus-bot
npm install
```

### Minimal Configuration

Create `user-config.json` in the project root:

```json
{
  "telegram": {
    "token": "YOUR_BOT_TOKEN",
    "chatId": "YOUR_CHAT_ID"
  }
}
```

That's enough to start. Argus will scan every 15 minutes and alert you via Telegram.

### First Run

```bash
npm start
```

You should see:

```
──────────────────────────────────────────
  🦅  ARGUS  v0.4.0
──────────────────────────────────────────

[Init] Layer 0 · Event Bus... ✓
[Init] Layer 1 · Persistence... ✓  clear (0/5 positions, $0.00 loss today)
[Init] Layer 2 · Intelligence Core... ✓
[Init] Layer 3 · Scheduler... ✓
[Init] Layer 3 · Wallet Observer... ✓
[Init] Layer 4 · Pattern Library... ✓
[Init] Layer 4 · Hivemind Discovery... ✓
[Init] Layer 5 · Telegram... ✓
[Init] Layer 5 · Web server... ✓

──────────────────────────────────────────
  Argus online → http://127.0.0.1:4000
──────────────────────────────────────────
```

Open **http://127.0.0.1:4000** for the Web UI dashboard.

---

## Configuration

All settings go in `user-config.json` (never edit the source files). Every field is optional — Argus uses sensible defaults.

### Full `user-config.json` Reference

```json
{
  "telegram": {
    "token": "YOUR_BOT_TOKEN",
    "chatId": "YOUR_CHAT_ID_OR_GROUP_ID"
  },

  "screening": {
    "minMcap": 50000,
    "maxMcap": 50000000,
    "minHolders": 200,
    "minVolume": 5000,
    "minTvl": 5000,
    "maxTvl": null,
    "minFeeActiveTvlRatio": 0.01,
    "minOrganic": 30,
    "maxVolatility": 4.0,
    "maxTokenAgeHours": 72,
    "timeframe": "30m",
    "category": "all"
  },

  "strategy": {
    "spotMaxVolatility": 2,
    "spotFeeTvlMin": 0.1,
    "spotFeeTvlMax": 0.4
  },

  "limitOrder": {
    "maxPriceVsAthPct": 70,
    "minPriceVsAthPct": 20,
    "maxVolatility": 2.0,
    "minOrganic": 50,
    "minHolders": 500,
    "minTvl": 10000
  },

  "scan": {
    "topCandidateLimit": 10
  },

  "dryRun": {
    "solAmount": 0.1,
    "stopLossPct": 20,
    "takeProfitPct": 50,
    "maxHoldMinutes": 240
  },

  "wallet": {
    "address": "YOUR_SOLANA_WALLET_ADDRESS",
    "rpcUrl": "https://api.mainnet-beta.solana.com",
    "pollIntervalMs": 30000,
    "trackedWallets": [
      { "address": "SMART_MONEY_WALLET_ADDRESS", "label": "alpha_whale" }
    ]
  },

  "helius": {
    "apiKey": "YOUR_HELIUS_API_KEY"
  },

  "ai": {
    "enabled": false,
    "sumopodUrl": "http://localhost:11434/v1/chat/completions",
    "model": "llama3",
    "maxTokens": 100,
    "timeoutMs": 20000
  },

  "meridian": {
    "enabled": false,
    "webhookUrl": null,
    "argusUrl": null,
    "smartWalletSync": false
  },

  "okx": {
    "apiKey": "YOUR_OKX_API_KEY",
    "secretKey": "YOUR_OKX_SECRET_KEY",
    "passphrase": "YOUR_OKX_PASSPHRASE"
  }
}
```

### Key Settings Explained

| Setting | Default | Purpose |
|---|---|---|
| `screening.minFeeActiveTvlRatio` | `0.01` | Min fee/TVL yield signal. Higher = only high-yield pools |
| `screening.maxVolatility` | `4.0` | Cap on price volatility. Lower = safer pools |
| `strategy.spotMaxVolatility` | `2` | Spot LP only below this volatility (calm pools) |
| `dryRun.solAmount` | `0.1` | Virtual SOL per paper trade |
| `dryRun.stopLossPct` | `20` | Close dry run if price drops >20% from entry |
| `wallet.pollIntervalMs` | `30000` | How often to check your wallet (ms). Min: 10000 |

---

## Features

### 1. Intelligence Core

Argus screens Meteora DLMM pools every 15 minutes using:
- **Pool Discovery API** — fee/TVL ratio, volume, volatility, holder count
- **OKX safety signals** — organic score, dev sold, top 10 concentration
- **Risk gate** — synchronous check before any recommendation (circuit breaker, blacklist)

**Strategy Routing:**
- `spot` — calm pool (vol < 2), moderate yield (fee/TVL 10–40%)
- `bid_ask` — higher volatility (vol 2–4), high yield
- `limit_order` — token pulled back from ATH (20–70%), low volatility, patient entry

**Confidence score** = rule-based score × 0.7 + historical win rate × 0.3 (Pattern Library) + smart money signal (+15% if confirmed)

### 2. Dry Run Engine

Every recommendation opens a virtual position at the current price. Updated every 5 minutes:
- **Stop loss**: closes at –stopLossPct% from entry
- **Take profit**: closes at +takeProfitPct% from entry
- **Timeout**: closes after maxHoldMinutes regardless

P&L includes simulated slippage (0.3%) and transaction cost ($0.002). Outcomes feed the Pattern Library.

### 3. Pattern Library

A conditional win-rate table indexed by `(volatility_bucket × regime × strategy)`:
- **Pending** (N < 20 samples): collected but not used
- **Active** (N ≥ 20): adjusts confidence scores (±30% blend)

Buckets: `volatility_bucket ∈ {low, medium, high}`, `regime ∈ {recovery, neutral, decline, froth}`

### 4. Wallet Observer

Polls on-chain Meteora transactions every 30 seconds for:
- **Own wallet** (`wallet.address`): detects when you follow an Argus recommendation → marks decision as "followed"
- **Smart money wallets** (static `trackedWallets` + Hivemind DB): detects LP activity → feeds confidence signal

### 5. Hivemind — Smart Money Discovery

Automatically finds smart money wallets from 5 sources (tries in order, stops at first success):

| Priority | Source | Key | How |
|---|---|---|---|
| 1 | Meteora (on-chain) | None | Wallets LP in ≥2 Argus-validated pools |
| 2 | Meteora Extended | None | Same, but seeds from top-volume pools |
| 3 | Helius | `helius.apiKey` | Enhanced ADD_LIQUIDITY tx detection |
| 4 | Solscan | None | Top token holders (lower precision) |
| 5 | OKX | `okx.apiKey` | OKX DEX smart money endpoint |

Rate limiting: each source has a 6-hour cooldown. Failures trigger exponential backoff (doubles each failure, max 24h). Auto-pauses after 5 consecutive failures.

### 6. LLM Verdict

Optional AI commentary on recommendations. Compatible with any OpenAI-format endpoint:
- [Ollama](https://ollama.ai) (local, free)
- [LM Studio](https://lmstudio.ai) (local, free)
- SumoPod (cloud)

Enable in config:
```json
{
  "ai": { "enabled": true, "model": "llama3" }
}
```

### 7. Circuit Breaker

Automatically stops recommendations when risk thresholds are breached:
- **Flash crash** detected (vol >3σ + price drop >15% in 5min)
- **Daily loss limit** exceeded (`RISK_MAX_DAILY_LOSS` env var, default $50)
- **Too many open positions** (`RISK_MAX_POSITIONS` env var, default 5)
- **Manual trigger** (via Web UI)

Reset via Web UI → Risk section → "Reset Circuit Breaker" button, or via Telegram.

---

## Web UI

Open **http://127.0.0.1:4000** after starting Argus.

| Card | Shows |
|---|---|
| **Risk State** | Circuit breaker status, open positions, daily loss |
| **Wallet Observer** | Own wallet status, today's actions, follow rate |
| **Hivemind Discovery** | Per-source status (ready/cooldown/paused), Run Now button |
| **Pattern Library** | Active patterns, sample count, best performing bucket |
| **Dry Run Stats** | Open positions, closed, win rate, avg P&L |
| **Active Decisions** | Current recommendations with strategy, confidence, LLM verdict |
| **Dry Run Positions** | Virtual trade history with P&L |
| **Pattern Library Table** | Full per-bucket breakdown |
| **Smart Money Wallets** | Hivemind-discovered wallets with source and pool_hits |
| **Wallet Actions** | On-chain actions from all tracked wallets |
| **Live Events** | Real-time event log |

---

## Telegram Alerts

Argus sends 3 types of alerts:

| Alert | Priority | Trigger |
|---|---|---|
| 🎯 **New Recommendation** | P2 | New pool decision made |
| 🔴 **Circuit Breaker** | P1 | CB opened (retries 5×) |
| ✅ **CB Reset** | P2 | Circuit breaker manually reset |
| 📊 **Dry Run Result** | P3 | Virtual position closed |
| 🐋 **Smart Money** | P3 | Tracked wallet LP'd into Argus-recommended pool |
| 🦅 **Startup** | P3 | Argus came online |

Alert format:
```
🎯 TOKEN · Spot LP · 82% conf · valid 20m
"Low vol, high fee — textbook spot entry"
Buka pool · Dashboard
```

---

## Meridian Integration

Argus can feed signals to the Meridian LP execution bot in two modes.

### Mode 1: Pull (Meridian polls Argus)

Meridian queries Argus's API periodically:

```
GET http://your-argus:4000/api/meridian/recommendations
→ List of active recommendations with strategy, confidence, indicators

GET http://your-argus:4000/api/meridian/pool/{poolAddress}/signal
→ Quick yes/no signal for a specific pool

GET http://your-argus:4000/api/meridian/smart-wallets
→ Smart wallet list in Meridian-compatible format (importable to smart-wallets.json)
```

### Mode 2: Push (Argus webhooks Meridian)

Argus pushes to Meridian's webhook endpoint whenever a new recommendation is made.

**Argus `user-config.json`:**
```json
{
  "meridian": {
    "enabled": true,
    "webhookUrl": "http://your-meridian-host/api/argus-signal",
    "argusUrl": "http://your-argus-host:4000"
  }
}
```

**Webhook payload:**
```json
{
  "source": "argus",
  "event": "new_recommendation",
  "ts": 1719360000000,
  "argus_url": "http://your-argus:4000",
  "data": {
    "pool_address": "...",
    "strategy": "spot",
    "confidence": 0.84,
    "token_symbol": "TOKEN",
    "expires_at": "2026-06-25T14:30:00.000Z",
    "smart_money_confirmed": true,
    "pool_url": "https://app.meteora.ag/dlmm/..."
  }
}
```

### Smart Wallet Sync to Meridian

Export Argus smart wallets to Meridian's `smart-wallets.json`:

```bash
# One-liner sync (run from Meridian directory)
curl -s http://localhost:4000/api/meridian/smart-wallets \
  | jq '{wallets: .wallets | map({name, address, category, type, addedAt})}' \
  > smart-wallets.json
```

Or automate with a cron job every 6 hours to keep Meridian's smart wallet list in sync with Argus's Hivemind discoveries.

---

## API Reference

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | System health, version, risk state |
| `GET` | `/api/risk` | Current risk state |
| `POST` | `/api/risk/circuit-breaker/reset` | Reset circuit breaker |
| `POST` | `/api/blacklist` | Add token/deployer to blacklist |
| `GET` | `/api/candidates?status=active` | Active/expired decisions |
| `POST` | `/api/scan/run` | Trigger manual scan |
| `GET` | `/api/dry-run?status=open` | Dry run positions |
| `GET` | `/api/pattern-library` | Pattern Library entries |
| `GET` | `/api/wallet-actions?limit=30` | Recent wallet actions |
| `GET` | `/api/hivemind` | Hivemind sources status |
| `GET` | `/api/hivemind/wallets` | Discovered smart wallets |
| `POST` | `/api/hivemind/run` | Trigger manual discovery |
| `POST` | `/api/hivemind/source/:name/pause` | Pause a source |
| `POST` | `/api/hivemind/source/:name/resume` | Resume a source |
| `GET` | `/api/meridian/recommendations` | Active decisions (Meridian format) |
| `GET` | `/api/meridian/pool/:address/signal` | Pool signal check |
| `GET` | `/api/meridian/smart-wallets` | Smart wallets (Meridian format) |
| `POST` | `/api/meridian/webhook/test` | Test Meridian webhook |

---

## Troubleshooting

### Argus won't start

```
Error: Cannot find module 'better-sqlite3'
```
→ Run `npm install`

```
Error: EADDRINUSE port 4000
```
→ Another process is using port 4000. Kill it:
```bash
# Windows
netstat -ano | findstr :4000
taskkill /PID <PID> /F
```
Or set a different port: `PORT=4001 npm start`

### No Telegram alerts

1. Verify `telegram.token` and `telegram.chatId` in `user-config.json`
2. Send `/start` to your bot first
3. Check `[Telegram]` lines in startup log — should say "✓ Telegram ready"
4. For group chats, chatId must be negative (e.g., `-1001234567890`)

### Wallet Observer disabled

```
[Wallet] Observer disabled — set wallet.address or wallet.trackedWallets in user-config.json
```
→ Add your wallet address to `user-config.json`:
```json
{ "wallet": { "address": "YOUR_SOLANA_ADDRESS" } }
```

### Hivemind sources always failing

Check the Web UI Hivemind card. If a source shows many failures:
1. **meteora** — check RPC URL is accessible
2. **helius** — verify `helius.apiKey` is valid
3. **solscan** — Solscan public API may be rate-limited; this is expected
4. Click **Resume** in the UI to reset a paused source

Sources fail gracefully — if all 5 fail, Argus keeps running normally.

### No recommendations after 15 minutes

1. Check `[IC]` logs — "Scan blocked by risk gate" means circuit breaker is open
2. Check the Web UI Risk card — if CB open, click Reset
3. Check screening thresholds — may be too tight for current market
4. Trigger a manual scan: click "▶ Scan Now" in the Web UI

### Circuit breaker keeps opening

The CB opens on flash crash detection (price drop >15% + volume spike in 5min). This is intentional. If it's triggering on normal volatility, adjust:
```json
{
  "screening": { "maxVolatility": 3.0 }
}
```
Or increase risk limits via environment variables:
```bash
RISK_MAX_DAILY_LOSS=100 npm start
```

### Pattern Library stuck at "Calibrating"

Pattern Library needs N≥20 outcomes to promote a bucket to "active". This is normal at the start. Speed up calibration by narrowing to one strategy:
```json
{ "scan": { "topCandidateLimit": 5 } }
```
Each scan produces up to 5 decisions → dry runs → outcomes feed the library.

### SQLite errors

If you see `SQLITE_CORRUPT` or schema errors:
```bash
# Back up and reset database
cp data/argus.db data/argus.db.bak
rm data/argus.db
npm start  # creates fresh DB
```

---

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Web server port |
| `RISK_MAX_POSITIONS` | `5` | Max open dry-run positions |
| `RISK_MAX_DAILY_LOSS` | `50` | Daily loss limit (USD) before CB |
| `ARGUS_SERVER_URL` | `http://localhost:4000` | Public URL (used in Telegram links) |

---

## Development

```bash
# Hot-reload (restarts on file changes)
npm run dev

# Check syntax
node --check src/core/init.js

# Test module loading
node -e "require('./src/db/schema').initSchema()"
```

---

## Roadmap

- [ ] Meridian receives and acts on Argus webhooks
- [ ] Cold-start seed: import Meridian historical positions into Pattern Library
- [ ] Pool watchlist: monitor specific pools even when not top-ranked
- [ ] Multi-timeframe screening (cross-reference 30m + 4h signals)
- [ ] Real wallet P&L tracking (not just dry run)
- [ ] VPS deployment guide + systemd service file
- [ ] Discord alerts
- [ ] On-chain smart money discovery via `getProgramAccounts` (deeper scan)

---

## License

MIT — see [LICENSE](LICENSE)

---

*Argus does not provide financial advice. All recommendations are for informational purposes only. LP positions carry risk of impermanent loss. DYOR.*
