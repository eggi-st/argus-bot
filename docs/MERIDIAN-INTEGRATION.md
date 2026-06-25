# Meridian Integration Guide

Argus and Meridian are two complementary bots:
- **Argus** — intelligence layer (screen, recommend, learn). No execution.
- **Meridian** — execution layer (deploy, manage, close LP positions).

Together they form a complete pipeline: Argus finds the opportunity, Meridian takes it.

---

## Integration Modes

### Pull Mode (Meridian queries Argus)

Meridian calls Argus API when evaluating a pool. This requires Argus to be running and reachable from Meridian's host.

**Pool signal check** — before Meridian deploys, it can ask Argus:

```bash
curl http://localhost:4000/api/meridian/pool/POOL_ADDRESS_HERE/signal
```

Response:
```json
{
  "recommended": true,
  "strategy": "spot",
  "confidence": 0.84,
  "expires_at": "2026-06-25T14:45:00.000Z",
  "condition_bucket": "low_vol_medium_yield_neutral",
  "smart_money_confirmed": true,
  "llm_verdict": "Clean spot entry — fee velocity strong, organic holders.",
  "reason": "Active Argus recommendation"
}
```

**All active recommendations:**

```bash
curl http://localhost:4000/api/meridian/recommendations
```

### Push Mode (Argus webhooks Meridian)

Every time Argus makes a new recommendation, it immediately POSTs to Meridian.

**Argus `user-config.json`:**
```json
{
  "meridian": {
    "enabled": true,
    "webhookUrl": "http://YOUR_MERIDIAN_HOST/api/argus-signal",
    "argusUrl": "http://YOUR_ARGUS_HOST:4000"
  }
}
```

**To add a webhook handler in Meridian**, add to Meridian's Express server:

```js
app.post('/api/argus-signal', express.json(), (req, res) => {
  const { data } = req.body
  if (!data?.pool_address || !data?.strategy) return res.sendStatus(400)

  // Log the signal
  console.log(`[Argus] Signal: ${data.token_symbol} → ${data.strategy} (conf: ${(data.confidence * 100).toFixed(0)}%)`)

  // Optionally feed into Meridian's screening queue
  // meridianQueue.push({ pool: data.pool_address, strategy: data.strategy, argusConf: data.confidence })

  res.json({ ok: true })
})
```

**Test the webhook:**
```bash
curl -X POST http://localhost:4000/api/meridian/webhook/test
```

---

## Smart Wallet Sync

Argus's Hivemind system discovers smart money wallets automatically. Meridian already has its own `smart-wallets.json` system — Argus can keep it updated.

### One-time export

From the Meridian directory:
```bash
curl -s http://localhost:4000/api/meridian/smart-wallets \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'))
    process.stdout.write(JSON.stringify(d, null, 2))
  " > smart-wallets.json
```

### Automated sync (cron job)

Add to crontab — runs every 6 hours (matches Hivemind discovery cycle):
```bash
0 */6 * * * curl -s http://localhost:4000/api/meridian/smart-wallets | python3 -c "
import json, sys
data = json.load(sys.stdin)
with open('/path/to/meridian/smart-wallets.json', 'w') as f:
    json.dump(data, f, indent=2)
print(f'Synced {data[\"total\"]} smart wallets from Argus')
" >> /var/log/argus-sync.log 2>&1
```

### Format compatibility

Argus outputs wallets in Meridian's exact format:
```json
{
  "wallets": [
    {
      "name": "sm_abc123",
      "address": "AbC123...",
      "category": "alpha",
      "type": "lp",
      "source": "argus_hivemind_meteora",
      "addedAt": "2026-06-25T12:00:00.000Z"
    }
  ],
  "total": 12,
  "generated_at": "2026-06-25T18:00:00.000Z"
}
```

---

## Suggested Meridian Screening Enhancement

When Meridian's screener (`get_top_candidates`) evaluates a pool, it can optionally check Argus:

```js
// In Meridian's screening tool
async function checkArgusSignal(poolAddress) {
  const argusUrl = process.env.ARGUS_URL || config.argusUrl
  if (!argusUrl) return null

  try {
    const res = await fetch(`${argusUrl}/api/meridian/pool/${poolAddress}/signal`, { timeout: 3000 })
    return await res.json()
  } catch {
    return null  // Argus unavailable — don't block screening
  }
}

// Usage in deploy decision:
const argusSignal = await checkArgusSignal(pool.address)
if (argusSignal?.recommended && argusSignal.confidence > 0.75) {
  // Boost confidence or auto-approve
  console.log(`Argus confirms: ${argusSignal.strategy} @ ${argusSignal.confidence * 100}% conf`)
}
```

---

## What Argus Knows That Meridian Doesn't

| Data | Argus | Meridian |
|---|---|---|
| Pattern Library (historical win rate per bucket) | ✓ | ✗ |
| Hivemind smart money (auto-discovered) | ✓ | Partial |
| Dry-run paper trading with P&L | ✓ | ✗ |
| Smart money confirmation signal | ✓ | ✗ (manual) |
| Multi-source fallback screening | ✓ | ✓ |
| Actual LP execution | ✗ | ✓ |
| Position management (rebalance, claim) | ✗ | ✓ |
| Real wallet P&L | ✗ | ✓ |

The two bots are designed to be independent but complementary. Neither requires the other to function.
