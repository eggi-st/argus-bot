# Candidate Strategy — Capitulation Catch (EvilPanda-inspired)

> Status: **candidate / proposal** (2026-06-27). Not implemented. Inspired by the
> "Evil Panda Strat" (Logical TA / @EvilPanda), studied from his X threads + community
> sources. This doc is the deep mechanical analysis + a formalization for Argus to
> dry-run and validate. NOT a recommendation to trade — a strategy to simulate and learn.

---

## 0. Source (what was actually retrieved)

Primary X threads were truncated by the API (~280 chars each); synthesized from fragments
+ community summaries. The consistent, verbatim-confirmed pieces:
- **Mechanic:** *"exit liquidity in a 10% fee pool … a −95% range for you to dump into"* (@EvilPanda)
- **Exit:** *"wait for RSI(2) to close above 90 and price to close above BB Upper Line"*
- **Discipline:** *"days where I don't find something I like and I just don't force myself"*
- Token-sided variant: *"4h charts look strong … gambling it remains strong … big pump to exit"*

Full token-selection (anti-rug) rules live in his YouTube guides (not text-extractable).

---

## 1. There are TWO Evil Panda modes — the candidate is Mode B

| | Mode A — pump-ride | **Mode B — capitulation catch (the candidate)** |
|---|---|---|
| Side | TOKEN-side, bins ABOVE price | **SOL(quote)-side, bins BELOW price** |
| Thesis | strong 4h momentum → ride pump, token sells into SOL on the way up | **panic dump → be the exit liquidity, accumulate token cheap + huge fees → bounce** |
| Closest Argus analog | token-side bid_ask (not in Argus today) | **same SIDE as Meridian's SOL bid, but radically different params** |

Mode A overlaps existing bid_ask intuition. **Mode B is the genuinely new, distinctive
play** ("Evil Panda = exit liquidity for panic sellers") and is what this doc formalizes.

---

## 2. Mode B mechanic — deep walkthrough (as a DLMM position)

1. **Deploy:** single-sided SOL across a **VERY WIDE** range below price (EvilPanda: down to
   −95%), in a **HIGH-FEE pool** (10%). This is the same *side* as Meridian's bid, but where
   Meridian places a narrow ~10-bin bid for a small dip, this spreads SOL across a huge range
   to catch a full capitulation.
2. **The dump fills you (DCA-in):** as price craters through your bins, your SOL buys the token
   bin-by-bin — a forced dollar-cost-average into the crash. At the bottom you hold mostly
   token, bought at a low average price inside the range.
3. **Fees are the engine:** every panic swap routes through your bins → you earn the **10% fee
   on the entire dump volume**. Violent dumps = enormous volume = the fee income is the real
   edge, not the price.
4. **The bounce:** when the token bounces, price rises back through your range → your token
   sells back into SOL. If it returns to entry, IL nets ≈0 and you keep the fees; if it exceeds,
   you profit on price too.
5. **Exit:** at `RSI(2) ≥ 90 AND close > BB upper` — overbought exhaustion of the bounce.

**The bet:** a *quality* token (not a rug) that dumps violently will (a) generate massive fee
volume on the way down and (b) bounce enough to exit. The fees + the cheap accumulation pay off.

**The killer risk:** if the token *doesn't bounce* (rug / dead) you're left holding depreciated
token across a −95% range = near-total loss of the converted SOL. This is why EvilPanda's
**anti-rug token selection is the load-bearing part of the strategy**, not the bins.

---

## 3. Mapping onto Argus's three axes

This is a clean fit for the strategy / condition / technique split:

| Axis | Value | Note |
|------|-------|------|
| **Strategy** (geometry) | `capitulation` — single-sided SOL, **WIDE** range below price, high-fee pool | NEW (vs narrow `limit_order`, tail-safe `bid_ask`, in-range `spot`) |
| **Condition** | high-vol × high-yield (froth) — the dump + 10% fee pool | Argus already buckets this |
| **Entry technique** | `bb_plus_rsi` (deep oversold + price ≪ lower band) on an anti-rug token | already in registry |
| **Exit technique** | `bb_plus_rsi` exit (`RSI(2) ≥ 90 & close > BB upper`) | already in registry — EvilPanda validates it with real money |
| **Author** | `evilpanda` (community) | new attributed author, like bengshark |

**It reuses our existing techniques** — the entry and exit are both `bb_plus_rsi` (lower/upper
band). What's new is the **geometry** (wide SOL) + the **pool selection** (high fee).

---

## 4. Parameters (proposed defaults to dry-run)

```jsonc
capitulation: {
  rangePct: 0.6,          // SOL spread 0–60% below entry (wide vs limit_order ~10 bins). Tunable.
  minFeeActiveTvl: 0.3,   // only HIGH-fee pools (froth) — the fee engine. EvilPanda used ~10%.
  entryTechnique: 'bb_plus_rsi',   // deep oversold capitulation
  exitTechnique:  'bb_plus_rsi',   // RSI(2)≥90 & close>BB upper (overbought bounce)
  // Anti-rug gates (the load-bearing part) — reuse Argus screening, tightened:
  minHolders: 800, minTvl: 20000, maxTop10Pct: 50, requireOrganic: 60,
}
```

---

## 5. Can Argus dry-run it? Mostly yes — with one model caveat

- **Geometry/IL:** `computeSingleSidedPnlPct(entry, current, rangeFraction)` already models a
  single-sided SOL bid converting as price dips. Just pass a **wide** `rangeFraction` (0.6).
- **Fees:** `computeSimulatedFeePct(feeRate, hold, window, inRangeFactor)` already credits fees
  scaled by the in-range fraction. ✅
- **⚠️ Caveat — the fee cap:** `maxSimulatedFeePct = 10` caps fee credit at 10pp. But Mode B's
  whole edge is *outsized* fees from a 10%-fee pool × violent dump volume — which can exceed 10pp.
  So Argus's sim would **under-credit** capitulation's real upside. For a faithful dry-run, raise
  the cap (or make it per-strategy) for `capitulation`.
- **Exit timing:** needs the `bb_plus_rsi` exit fired during the hold (Phase 6-adjacent: the
  dry-run engine would poll indicators to detect the bounce-exhaustion exit, vs today's
  price/fee/hold exits). Until then, approximate with `net_target` + `max_hold`.

---

## 6. Risk profile — the highest-risk strategy we'd carry

- **Falling-knife / rug:** catching a −95% dump on a token that never recovers = near-total loss.
  Mitigation is entirely in **token selection** (anti-rug) + selectivity ("don't force"). Argus's
  screening must be *tightest* for this strategy.
- **Asymmetric payoff:** many small fee-wins + occasional large losses (un-bounced dumps). The
  win-rate could look high while a few catastrophic losses dominate P&L — so judge it by
  **net P&L distribution**, not win-rate alone. (Mirrors the −0.6%/+8.7% asymmetry we already saw.)
- Therefore it needs **more** dry-run validation than any other strategy before it's trusted.

---

## 7. Validation path (how it earns trust)

1. **Dry-run shadow only.** Add `capitulation` as a 4th scan pipeline (alongside bid_ask/spot/
   limit_order) — Argus simulates it, never gates live on it.
2. Register strategy `capitulation` + author `evilpanda` in the technique registry (provenance).
3. Let `pattern_library` + the attribution rollup measure its **net-P&L distribution** (not just
   win-rate) across many sims, especially in froth/high-fee buckets.
4. Compare its dry-run edge to bid_ask/limit_order in the same conditions. Only if it shows a
   real, distribution-aware edge does it graduate from candidate.
5. If/when Meridian runs a real version, the live feedback loop attributes its real edge to
   `evilpanda` — closing the loop (Phase 5).

---

## 8. Implementation sketch (when greenlit — not now)

- `config.js`: add `capitulation` block (§4) + a `{ profile: 'capitulation', strategy: 'capitulation' }`
  scan pipeline; per-strategy fee cap.
- `strategy-router.js`: `capitulation` eligible when `bb_plus_rsi` entry confirms (deep oversold)
  AND anti-rug gates pass AND pool fee/TVL ≥ threshold.
- `engine.js`: `rangePctForStrategy` → wide for capitulation; raise fee cap; wire `bb_plus_rsi`
  exit (bounce) when indicator-exit lands.
- schema: allow `capitulation` in strategy CHECKs (or keep it feedback/dry-run only, like spot_lo,
  to avoid the migration).
- registry: `capitulation` techniques/author `evilpanda`.

---

## 9. The meta-lesson (independent of the strategy)

EvilPanda's strongest, most transferable principle isn't a parameter — it's **selectivity**:
*"don't force a trade; some days you find nothing."* Argus already embodies this (it rejects the
vast majority of candidates). This validates our confidence-gate + anti-rug screening: **refusing
to act is a feature.** Any capitulation strategy must inherit the *tightest* selectivity, because
its downside (un-bounced dumps) is the most punishing.
