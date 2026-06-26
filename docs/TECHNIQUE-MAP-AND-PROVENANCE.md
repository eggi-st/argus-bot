# Technique Map & Provenance — Design

> Status: **design / proposal** (2026-06-26). No code shipped yet.
> Author of this doc: Argus AI analysis, from a working session with eggi.
> Trigger: limit_order never fires (data-starved ATH gate) → pivot to
> indicator-driven, **attributed** technique architecture.

---

## 0. The one-sentence idea

Today Argus describes a position with **two** axes — *what shape*
(`strategy`) and *what market state* (`condition_bucket`). This design adds
the missing **third axis**: *why we entered and whose idea it was*
(`technique` + `author`). A technique becomes a first-class, **attributed**
object — RSI is "Wilder, wired by Meridian", Fast Bid-Ask is "bengshark,
community", a learned win-rate edge is "argus-ai". Every open pool then
carries a full status tuple:

```
(strategy)  ×  (condition_bucket = struktur keadaan)  ×  (technique = teknik siapa)  ×  (author = indikator siapa)
```

---

## 1. Why this matters — the three orthogonal axes

The current code conflates timing/authorship into the strategy. They are
independent:

| Axis | Question it answers | Where it lives today | Example |
|------|--------------------|--------------------|---------|
| **Strategy** | *How* is liquidity shaped? | `decisions.strategy` | `bid_ask`, `spot`, `limit_order` |
| **Condition** | *What* market state? | `decisions.condition_bucket` | `high_vol_high_yield_froth` |
| **Technique** ⟵ NEW | *Why* enter / *who* says so? | — (missing) | `bb_plus_rsi` by classic-TA; `bonus_stage` by bengshark |

Strategy = the **bin geometry** (single-sided tail-safe vs in-range calm vs
bid-below-price). Technique = the **trigger rule** that says *now is a good
moment*. The same technique can gate several strategies; some pairings are
much stronger than others (§5). Keeping them separate lets Argus learn
**which author's technique actually has edge in which state** — turning
anecdote into measured win-rate.

---

## 2. Deeper re-analysis of this session (what we actually learned)

A faithful synthesis of the whole investigation, with the data:

### 2.1 The backup DB (VPS, 2026-06-26, ~10.5h, 03:19→13:45)
- **52 decisions → 52 dry-run positions** (49 closed, 3 open). 48 distinct
  scan-minutes ≈ every 15 min. Numbers reconcile cleanly.
- **bid_ask +2.55% avg, 55% win (17/31)** vs **spot −0.44%, 11% win (2/18)**.
  Argus already gives spot low confidence (avg 0.35) — internally consistent.
- **Every single close = `ttl_expired`.** Not one take-profit / stop-loss /
  out-of-range exit. The dry-run closes on a fixed timer (~22 min avg), so
  simulated P&L = *fee accrual over a fixed window*, not realistic exit.
- **Zero limit_order samples** in `pattern_library` (14 rows, all bid_ask/spot).
- **No Meridian feedback** landed in this snapshot (`decisions.outcome_*` all 0).

### 2.2 Why limit_order never fires — self-diagnosed
Argus's own `capability_gaps` row says it best:
> *"limit_order can never qualify without ATH/price-history data — OKX
> returns no maxPrice for fresh tokens. Wire a second source."* — argus self-report

- Gate: `price_vs_ath_pct ∈ [20%, 70%]` (router) — **null 91.7%** of the time
  (33/36 evals over 22 scans).
- Root cause is **data starvation, not mis-tuned thresholds.** 92% fail at the
  *first* gate (`priceVsAth == null`) before any number is compared. Loosening
  the band does nothing.
- The internal ATH water-mark (`token_ath`, 19 tokens ≥3 obs) helps the
  bid_ask/spot universe but rarely the ≥7-day limit_order universe, which
  churns and doesn't accumulate observations.

### 2.3 The pivot — and the unlock we found
- A DLMM limit order = **single-sided SOL in bins *below* price**; fills when
  price dips into the bin (you "buy the dip") and earns 50% swap fees in
  transit. So the *right* trigger is a **reversal/oversold** signal, not a
  static ATH ratio.
- **bengshark's posts** ([1](https://x.com/bengsharksol/status/2068126848001978462),
  [2](https://x.com/bengsharksol/status/2060220900428177743)) crystallise the
  point: his hardest problem is **entry timing** ("susah mantengin chart nunggu
  masuk"), and his method is *"simulate your entry"* on historical charts —
  which is **exactly what Argus dry-run + pattern_library automate.** His
  "Fast Bid-Ask, Bonus Stage" pattern (7 entries, 6W/1L front-test) is a
  high-win-rate bid_ask trigger, attributable to him.
- **The unlock:** Meridian *already* has a full indicator engine
  (`meridian/tools/chart-indicators.js`) with the presets we need, fed by the
  `agentMeridian /chart-indicators/{mint}` endpoint (OHLCV → RSI / Bollinger /
  Supertrend / Fibonacci, computed server-side). No new vendor, key already in
  config. Argus can reuse the same source.

### 2.4 The connective insight (ties 2.1 → 2.3)
The "100% ttl_expired" finding and the limit_order fix are the **same gap**:
Argus has no **technique-level entry/exit signals**. Give it techniques and:
(a) limit_order gets a real entry trigger (RSI/BB dip), and (b) the dry-run
can close on **technique-driven exits** (supertrend break, RSI overbought)
instead of a blind timer — making *all three* strategies' simulated P&L far
more realistic. One architecture fixes both.

---

## 3. The Technique Registry (attributed)

A technique is a named, versioned, **authored** signal rule. Provenance is the
headline feature — "preset atas nama orang yang memberikan saran atau atas AI".

```jsonc
{
  "id": "bb_plus_rsi",
  "label": "Bollinger + RSI dip",
  "author": "classic-ta",            // WHO
  "author_type": "classic_ta",       // classic_ta | community | ai_derived | user
  "attribution": "Bollinger (1980s) + Wilder RSI (1978); wired by Meridian chart-indicators",
  "source_ref": "meridian/tools/chart-indicators.js#bb_plus_rsi",
  "inputs": ["close", "lowerBand", "rsi"],
  "rule": "close <= lowerBand && rsi <= oversold",
  "side": "entry",                   // entry | exit | both
  "applies_to": ["limit_order"],     // strategies it serves (see §5)
  "maturity": "battle_tested",       // proposed | dry_run | battle_tested
  "version": 1
}
```

### Author types (provenance taxonomy)
| `author_type` | Meaning | Examples |
|---------------|---------|----------|
| `classic_ta` | Public-domain indicator, wired by us/Meridian | RSI, Bollinger, MACD, Supertrend, Fibonacci |
| `community` | A named person's empirical pattern | **bengshark** — "Fast Bid-Ask Bonus Stage" |
| `ai_derived` | Argus discovered the edge itself | learned `pattern_library` win-rates; LLM-proposed rules |
| `user` | eggi's own hand-tuned rule | custom gates |

`community` and `user` techniques carry a `source_ref` URL (e.g. the X post)
so credit + provenance is auditable.

---

## 4. The technique catalogue (initial)

Ported from `meridian/tools/chart-indicators.js` plus proposals. `O` = OHLCV
needed (via agentMeridian); `L` = local data Argus already has.

| id | label | author / type | side | data | status |
|----|-------|---------------|------|------|--------|
| `vol_feetvl_gate` | Volatility + fee/TVL bands | argus-ai (val. 214 spot + 145 bid_ask) | entry | L | live |
| `pattern_edge` | Learned (vol×regime×strat) win-rate | argus-ai | entry | L | live |
| `smart_money` | Tracked-wallet LP confirm | argus-ai / hivemind | entry | L | live |
| `rsi_reversal` | RSI ≤ oversold | classic-ta (Wilder) | both | O | port |
| `bollinger_reversion` | Close ≤ lower band | classic-ta (Bollinger) | both | O | port |
| `bb_plus_rsi` | Lower band **and** RSI oversold | classic-ta | entry | O | port |
| `supertrend_break` | Supertrend flip | classic-ta (Seban) | both | O | port |
| `supertrend_or_rsi` | Trend bull **or** RSI oversold | classic-ta | entry | O | port (Meridian's live default) |
| `rsi_plus_supertrend` | RSI oversold **and** bull trend | classic-ta | entry | O | port |
| `fibo_reclaim` / `fibo_reject` | Reclaim/reject a Fib level | classic-ta | both | O | port |
| `rsi_dump_entry` | RSI-graded dump entry | classic-ta | entry | O | port |
| `bonus_stage` | "Fast Bid-Ask, Bonus Stage" | **bengshark** / community | entry | O+L | research |
| `macd_cross` | MACD bullish/bearish cross | classic-ta (Appel) | both | O | **not built** |

Note: the engine has **no MACD** today — `macd_cross` is a proposal. For
dip-timing, `bb_plus_rsi` is usually sharper than MACD anyway.

---

## 5. The deep mapping: technique × strategy

The core "pemetaan". Strategy = liquidity geometry; technique = trigger.
Fit is driven by what each geometry *needs*:

- **`limit_order`** = bid **below** price → wants a **dip that will bounce**
  (oversold reversal). Falling-knife protection matters most.
- **`bid_ask`** = tail-safe, captures vol on **both** sides → wants
  **trend/breakout or high-vol** confirmation; tolerates froth/decline.
- **`spot`** = in-range, **calm** fee farming → wants **low-vol / mean-revert**
  confirmation; oversold-crash signals are *wrong* here (spot needs stability).

Legend: `★★★` ideal · `★★` good · `★` situational · `–` unsuitable · `EXIT` exit-only

| Technique | author | bid_ask | spot | limit_order | Why |
|-----------|--------|:------:|:----:|:-----------:|-----|
| `vol_feetvl_gate` | argus-ai | ★★★ | ★★★ | ★ | current router core; calm→spot, hot→bid_ask |
| `pattern_edge` | argus-ai | ★★ | ★★ | ★★ | learned edge modulates any strategy |
| `smart_money` | argus-ai | ★★ | ★★ | ★★ | confidence boost, strategy-agnostic |
| `rsi_reversal` | classic-ta | ★ | – | ★★★ | oversold = dip entry → LO |
| `bollinger_reversion` | classic-ta | ★ | ★★ | ★★★ | lower band = LO bid; mid band = spot range |
| `bb_plus_rsi` | classic-ta | – | ★ | ★★★ | strongest dip-reversal → LO |
| `supertrend_or_rsi` | classic-ta | ★★★ | ★ | ★★ | trend confirm = bid_ask (Meridian's live default) |
| `rsi_plus_supertrend` | classic-ta | ★★ | – | ★★ | reversal **into** uptrend |
| `supertrend_break` | classic-ta | EXIT | EXIT | EXIT | universal exit signal |
| `fibo_reclaim` | classic-ta | ★ | – | ★★ | support reclaim → LO entry |
| `bonus_stage` | bengshark | ★★★ | – | ★ | his high-WR bid_ask pattern |
| `macd_cross` (proposed) | classic-ta | ★ | – | ★★ | momentum turn → LO timing |

**Reading the matrix:** limit_order's natural authors are the reversal family
(`bb_plus_rsi`, `rsi_reversal`, `bollinger_reversion`, `fibo_reclaim`) — none
of which need ATH data, all available via the existing OHLCV source. bid_ask's
natural authors are trend/vol (`supertrend_or_rsi`, `vol_feetvl_gate`,
bengshark's `bonus_stage`). spot stays mean-revert/calm.

---

## 6. Pool / position status model

Extend the record so every open pool's status is the full tuple. Proposed
`signal_provenance` JSON on the decision:

```jsonc
{
  "strategy": "limit_order",
  "condition_bucket": "low_vol_high_yield_decline",   // struktur keadaan
  "primary_technique": "bb_plus_rsi",                  // teknik siapa
  "author": "classic-ta",                              // indikator siapa
  "confirmations": [
    { "technique": "bb_plus_rsi", "author": "classic-ta",
      "confirmed": true, "reason": "close<=lowerBB & RSI 22<=30",
      "interval": "15_MINUTE" }
  ],
  "exit_technique": "supertrend_break"                 // how it should close
}
```

UI surfacing — an open pool reads, e.g.:
> **VALORA** · `limit_order` · low-vol / decline · **via bb_plus_rsi** (classic-TA / Meridian) · exit on supertrend break

or, when a community author triggers it:
> **PEPE** · `bid_ask` · high-vol / froth · **via bonus_stage** (bengshark) · …

This is exactly "status sebuah open pool berdasarkan struktur keadaan atau
teknik siapa atau indikator siapa."

---

## 7. Schema extensions (concrete)

Additive, backward-compatible (all nullable):

```sql
-- New: technique registry (provenance source of truth)
CREATE TABLE IF NOT EXISTS techniques (
  id            TEXT PRIMARY KEY,          -- 'bb_plus_rsi'
  label         TEXT NOT NULL,
  author        TEXT NOT NULL,             -- 'classic-ta' | 'bengshark' | 'argus-ai' | 'eggi'
  author_type   TEXT NOT NULL CHECK(author_type IN ('classic_ta','community','ai_derived','user')),
  attribution   TEXT,
  source_ref    TEXT,                      -- code path or X URL
  side          TEXT CHECK(side IN ('entry','exit','both')),
  applies_to    TEXT,                      -- JSON array ["limit_order"]
  maturity      TEXT DEFAULT 'proposed',   -- proposed | dry_run | battle_tested
  version       INTEGER DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- Decisions: add provenance (nullable, additive)
ALTER TABLE decisions ADD COLUMN primary_technique TEXT;      -- FK techniques.id
ALTER TABLE decisions ADD COLUMN technique_author  TEXT;
ALTER TABLE decisions ADD COLUMN signal_provenance_json TEXT; -- full §6 object

-- Dry-run: record which technique closed it (replaces blind ttl_expired)
ALTER TABLE dry_run_positions ADD COLUMN entry_technique TEXT;
ALTER TABLE dry_run_positions ADD COLUMN exit_technique  TEXT;  -- 'supertrend_break' | 'ttl_expired'
```

### Learning dimension — careful, not naive
Adding `technique` as a 4th `pattern_library` key multiplies cells and worsens
sparsity (we're already pre-promotion everywhere). Recommended:

- **Keep primary learning** at `(vol_bucket × regime × strategy)` (unchanged).
- **Add a secondary, coarse rollup** `pattern_by_technique (technique × strategy)`
  — "does bengshark's `bonus_stage` actually win, across states?" Lower
  promotion bar, used for attribution dashboards, not gating.
- This answers "whose technique has edge" without starving the main learner.

---

## 8. Attributed presets — extending `confirmIndicatorPreset`

Meridian's `confirmIndicatorPreset({mint, side, preset})` already returns
`{confirmed, reason, signal}`. Wrap it so the **preset is a registry entry**:

```js
// Argus-side mirror
const verdict = await confirmTechnique(mint, {
  technique: 'bb_plus_rsi',   // resolves author + attribution from registry
  side: 'entry',
  intervals: ['15_MINUTE'],
})
// → { confirmed, reason, author:'classic-ta', technique:'bb_plus_rsi', signal:{...} }
```

New community/AI presets register the same way:
- `bonus_stage` → `author:'bengshark', source_ref:'x.com/bengsharksol/...'`
- an LLM-proposed rule → `author:'argus-ai', author_type:'ai_derived'`

So every confirmation is **self-attributing** end-to-end: signal → decision →
position → outcome → pattern, all carrying who authored it.

---

## 9. Closing the Meridian loop at technique level

Meridian already computes `confirmIndicatorPreset` per live entry. If its
`/api/feedback` payload to Argus adds the **technique + author that confirmed
the entry**, Argus learns **real-execution** win-rates per technique per
author — not just dry-run. That upgrades the existing feedback loop
([[meridian-single-sided-sol]]) from "strategy outcome" to "technique outcome",
and finally lets `bonus_stage` (bengshark) and `bb_plus_rsi` (classic-ta) be
ranked by *proven* edge.

---

## 10. Implementation phases (REVISED — exits before the entry A/B)

Key insight from §11.4: you cannot fairly A/B-test entry techniques while
exits are 100% blind timers — the P&L is dominated by fee-over-fixed-window,
not entry quality. So **exit realism is a prerequisite** for the entry test.
Revised order:

1. **Registry + provenance plumbing** (no behaviour change): `techniques`
   table, seed catalogue (§4), additive decision/position columns, UI shows
   author on open pools. *Pure attribution, zero risk.* ✅ **SHIPPED 2026-06-26.**
2. **Exit by technique (3-lite)**: replace blind `ttl_expired` with
   outcome-driven exits (net_target / il_stop / price_ran_up / max_hold) +
   fill-scaled slippage → realistic P&L for **all** strategies.
   ✅ **SHIPPED 2026-06-26** (commit cd3a054). Also fixed the −0.6% floor
   (flat round-trip slippage charged on bids that never filled).
3. **limit_order trigger swap + shadow A/B**: gate limit_order on `bb_plus_rsi`
   via agentMeridian (fallback to ATH when OHLCV unavailable); record
   `supertrend_or_rsi` as a parallel shadow for `pattern_library` to compare.
   ✅ **SHIPPED 2026-06-26** (commit ef35336). Live proof: first-ever
   limit_order decision (ZINC, RSI 16.9 + price below lower band); gate rejected
   6 RSI-oversold-but-not-below-band candidates.
4. **Secondary technique learning** `(technique × strategy)` + attribution dashboard.
5. **Meridian feedback carries technique** → real-execution edge per author.

---

## 11. Decisions — RESOLVED (2026-06-26)

1. **Sparsity tradeoff** → **secondary rollup** `(technique × strategy)`, main
   learner unchanged. Full 4th key would balloon ~36 cells → hundreds; at ~50
   samples/day a cell needs months to reach N≥45. Granularity can be added
   later when volume justifies it; un-slowing a learner cannot.
2. **limit_order semantics** → **yes, safe + tunable**, *via dry-run first*.
   Safe because: additive + ATH fallback (never breaks bid_ask/spot), dry-run
   must prove edge before anything goes "active", all knobs in config, change
   is reversible (gate logic, not data migration).
3. **Default limit_order technique** → **`bb_plus_rsi`** (it's pure
   dip-confirmation = correct match for bid-below-price). `supertrend_or_rsi`'s
   trend branch is semantically mismatched to limit_order and belongs to
   **bid_ask** — so they're not competitors for one slot. Run both as attributed
   techniques; data confirms long-term. (True historical backtest not possible
   without OHLCV history — the shadow A/B in dry-run *is* the test.)
4. **Exit by technique** → **do it early (now Phase 2)** — it's a prerequisite
   for a trustworthy entry A/B and fixes the 100%-`ttl_expired` realism gap.
```
