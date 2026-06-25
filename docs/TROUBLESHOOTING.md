# Troubleshooting Guide

## Startup Problems

### Port 4000 already in use

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:4000
```

Find and kill the process:
```bash
# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 4000 -State Listen | Select OwningProcess
Stop-Process -Id <PID> -Force

# Or use a different port
$env:PORT=4001; npm start
```

### Module not found

```
Error: Cannot find module 'better-sqlite3'
```
→ `npm install`

```
Error: Cannot find module './rpc-client'
```
→ You're running from the wrong directory. Always run from the project root: `cd argus-bot && npm start`

### SQLite build error

```
Error: The module '...better_sqlite3.node' was compiled against a different Node.js version
```
→ Rebuild native modules: `npm rebuild better-sqlite3`

---

## No Output / Silent Failures

### Argus starts but no Telegram alerts

1. Check startup log for `[Telegram] ✓ Telegram ready`
2. Verify token: `telegram.token` should be `123456789:ABC...`
3. Verify chatId: use [@userinfobot](https://t.me/userinfobot) to get your chat ID
4. For group chats: bot must be **added to the group** and chatId is negative
5. Test manually:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=test"
   ```

### Scan runs but no recommendations appear

Common causes:
1. **Circuit breaker open** — check Web UI Risk card or log for `[IC] Scan blocked by risk gate`
2. **Screening too strict** — loosen thresholds in `user-config.json`
3. **All pools blacklisted** — check `[IC]` logs for "blocked" messages
4. **Network issue** — check log for `[Screener]` errors fetching Meteora API

### Pattern Library always shows "Calibrating"

Normal for first 20 outcomes. Check progress:
```bash
# From project root
node -e "
  const db = require('./src/db/database')
  const rows = db.prepare('SELECT volatility_bucket, regime, strategy, sample_count, active FROM pattern_library').all()
  console.table(rows)
"
```

---

## Risk & Circuit Breaker

### CB keeps triggering on "flash_crash"

The flash crash trigger is: price drop >15% AND volatility spike in 5 minutes. If your target tokens are volatile by nature, either:
1. Tighten screening: `{ "screening": { "maxVolatility": 2.5 } }`
2. Raise the CB threshold via env var (advanced): the trigger threshold is hardcoded at 15% for safety

### CB open with no obvious reason

Check the reason:
- **daily_loss_limit** — dry run P&L exceeded `RISK_MAX_DAILY_LOSS`. Run: `RISK_MAX_DAILY_LOSS=100 npm start`
- **manual** — you opened it manually via Telegram/UI. Click Reset.
- **data_stale** — API was slow or unreachable during a check. Reset and monitor.

Reset via Web UI → Risk card → Reset button, or:
```bash
curl -X POST http://localhost:4000/api/risk/circuit-breaker/reset
```

---

## Wallet Observer

### Observer shows "disabled"

```
[Wallet] Observer disabled — set wallet.address or wallet.trackedWallets in user-config.json
```
→ Observer needs at least one wallet. Add to `user-config.json`:
```json
{ "wallet": { "address": "YOUR_SOLANA_WALLET_ADDRESS" } }
```

### "getSignaturesForAddress error"

Public Solana RPC has strict rate limits. Solutions:
1. Use Helius free RPC: `{ "wallet": { "rpcUrl": "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY" } }`
2. Increase poll interval: `{ "wallet": { "pollIntervalMs": 60000 } }`

### Actions not detected

The observer only detects **Meteora DLMM** actions. It identifies them via transaction log messages (`Instruction: AddLiquidity`, etc.). Other DEXes (Raydium, Orca) are ignored by design.

---

## Hivemind Discovery

### Source "meteora" fails with "No recent decisions"

Hivemind seeds from your recent Argus decisions. Run a scan first: Web UI → "▶ Scan Now". After the first scan, Meteora source will have pool seeds.

### Source "helius" fails with "API key invalid"

1. Verify key at [helius.xyz](https://helius.xyz) dashboard
2. Free tier has 100k credits/month — check usage
3. The key goes in `user-config.json`: `{ "helius": { "apiKey": "your-key" } }`

### Source "solscan" fails with "403 Forbidden"

Solscan's public API endpoints require authentication in newer versions. This is expected — the orchestrator automatically skips to the next source. You can permanently pause it:
```bash
curl -X POST http://localhost:4000/api/hivemind/source/solscan/pause
```

### All sources stuck in "cooldown"

Sources have a 6-hour default cooldown after success. After failure, it doubles (exponential backoff). To force a run now:
```bash
curl -X POST http://localhost:4000/api/hivemind/run
```
The `/run` endpoint bypasses the cooldown check.

Wait — actually `/run` doesn't bypass cooldown. To force immediately:
1. Resume paused sources in Web UI
2. Wait for cooldown, or restart Argus (state resets)
3. Or directly reset in DB (advanced):
   ```bash
   node -e "
     const db = require('./src/db/database')
     db.prepare('UPDATE discovery_sources SET last_run = NULL, paused_until = NULL').run()
     console.log('Cooldowns cleared')
   "
   ```

---

## Database Issues

### Corrupt database

```bash
# Back up and reset
cp data/argus.db data/argus.db.$(date +%Y%m%d)
rm data/argus.db
npm start   # creates fresh DB
```

### Check database contents

```bash
node -e "
  const db = require('./src/db/database')
  const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all()
  for (const {name} of tables) {
    const count = db.prepare('SELECT COUNT(*) as c FROM ' + name).get().c
    console.log(name + ':', count, 'rows')
  }
"
```

Expected output after first run:
```
decisions: 0
dry_run_positions: 0
pattern_library: 0
wallet_actions: 0
blacklist: 0
tracked_wallets: 0
discovery_sources: 5
```

### "no such column: wallet_type" or similar

Migration may not have run. Force it:
```bash
node -e "
  require('./src/db/schema').initSchema()
  console.log('Migration complete')
"
```

---

## Performance

### Argus using too much CPU

The wallet observer polls every 30 seconds. If you have many tracked wallets, each poll makes multiple RPC calls. Slow it down:
```json
{ "wallet": { "pollIntervalMs": 120000 } }
```

### High memory usage after many hours

Node.js shouldn't have significant memory growth. If you see it, check for uncaught promise rejections in logs. Restart if necessary — Argus is stateless (all data in SQLite).

---

## Meridian Integration

### Webhook not received by Meridian

1. Test connectivity: `curl -X POST http://localhost:4000/api/meridian/webhook/test`
2. Check that `meridian.webhookUrl` is reachable from Argus's host
3. Look for `[Meridian] Webhook HTTP ...` in Argus logs
4. Ensure Meridian's server is running and the endpoint exists

### Smart wallet sync not working

The sync is manual (via `curl`) or via cron. There's no automatic push — Argus just exposes the endpoint. Set up the cron job in the [integration guide](MERIDIAN-INTEGRATION.md).

---

## Getting Help

- **GitHub Issues**: [github.com/eggi-st/argus-bot/issues](https://github.com/eggi-st/argus-bot/issues)
- **Check logs first**: most issues are visible in the startup log or `[IC]`/`[Wallet]` prefixed lines
- **Web UI Live Events**: bottom of the dashboard shows real-time event stream
