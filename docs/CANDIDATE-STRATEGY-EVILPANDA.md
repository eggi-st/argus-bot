# Candidate Strategy — Evil Panda Strat (wide-range trend-follow)

> Status: **candidate / proposal** (2026-06-27). Not implemented. Based on EvilPanda's
> (Logical TA) own AMA + token-selection video transcripts (user-supplied — high fidelity,
> supersedes the earlier "capitulation catch" sketch which mis-read the entry).
> A strategy to dry-run + validate, NOT a recommendation to trade.

---

## 0. Correction vs the first sketch

The first draft framed this as "catch the capitulation dump." **Wrong.** From his own AMA:
- **Entry is trend-following** — Supertrend on 15m (with 4h for context), NOT knife-catching.
- The **wide range is INSURANCE** (stay in range, keep earning fees if it dumps), not the entry thesis.
- The real edge is **rigorous anti-rug coin selection** + **disciplined early exit**.

---

## 1. The actual Evil Panda Strat

| Component | Rule (from his AMA) |
|-----------|---------------------|
| **Coin selection** | Heavy manual anti-rug audit (§2) — *"the load-bearing part"* |
| **Entry** | **Supertrend on 15m** (4h chart for overall strength/context) |
| **Range** | **WIDE, up to 90%** — insurance: position stays active + collects fees even on a 70–80% drop, exits with minimal damage on a bounce |
| **Exit (early TP)** | ANY of: **RSI(2) > 90**, price crosses **Bollinger** (upper/mid), or **first green MACD histogram bar**. Don't time the top — take profit early |
| **Position limits** | Max **4–5 entries per token**; if it fails, **walk away** (never average down into a rug) |
| **Sizing** | **5 SOL**/position (experienced); **0.5–1 SOL** for beginners |
| **Discipline** | *"Some days I find nothing and I don't force it."* Selectivity > activity |

The "exit liquidity / −95% range" framing in his tweets = the **wide-range insurance**, stated
provocatively (a wide range means panic sellers dump *into* you, so you accumulate + earn fees).

---

## 2. Anti-rug coin selection — the real edge (concrete ruleset)

This is what he spends most of the audit on. Tools: DexScreener → GMGN → Axiom/BubbleMaps.

| Check | EvilPanda threshold | Why |
|-------|---------------------|-----|
| **Top 10 holders** | **< 15–16%** | concentration = dump risk |
| **Insider %** | **< 10%** (caution if red / > 20%) | dev/insider control |
| **TVL / mcap ratio** | **≤ 5** (red flag if high, e.g. 400k mcap + 80–90k TVL) | high TVL on small mcap = devs luring LPs to be **exit liquidity** = rug setup |
| **Total fees (wash check)** | **≥ 30** (GMGN "global fees") | low fees + high volume = **fake/wash-traded** volume → discard |
| **Volume** | **≥ ~1M** | real liquidity/interest |
| **Market cap** | **≥ $250k** | filter dust |
| **Age** | **> 3–6h** (avoid pump-dump) and **< ~1 week** (avoid stale/low-vol) | data not reliable < 6h; old = dead |
| **Bundle (GMGN "bundler fishing")** | look for **red indicators**, not the exact %; 50% red alone ≠ scam | coordinated supply |
| **Zero-buy holders** | none of top 10 with "0 avg buy" | got tokens off-market (bundled), didn't buy → manipulated |
| **Shared funding / dust / inactive** | flag same funding-source timing; dust to many wallets; 80–92% "unknown" holders | bundling / fake holder count |
| **Bubble map** | clean — disconnected nodes, no large interconnected clusters | decentralized supply |
| **Avoid types** | vampire coins, political coins, suspicious CTOs | known traps |

He maintains a **manual blacklist** in his bot: anything failing the qualitative audit gets the
CA blacklisted so the bot never LPs it, even if it passes quantitative filters.

---

## 3. Mapping onto Argus's three axes (corrected)

| Axis | Value | Argus status |
|------|-------|--------------|
| **Strategy** (geometry) | `wide_range` — single-sided, **very wide** range (insurance), fee-harvest through volatility | NEW (vs narrow bid_ask / limit_order) |
| **Condition** | trend-up on 15m/4h, healthy fees | partially modeled |
| **Entry technique** | **Supertrend (15m)** → our `supertrend_or_rsi` (or a dedicated `supertrend`) | in registry |
| **Exit technique** | RSI(2)>90 **or** BB cross **or** first-green-MACD | RSI+BB = our `bb_plus_rsi` exit; **MACD = not built** (proposal `macd_cross`) |
| **Screening** | the §2 anti-rug ruleset | mostly maps to Argus knobs (§4) |
| **Author** | `evilpanda` (community) | new attributed author |

---

## 4. Two actionable tracks

### Track A — sharpen Argus's screener NOW (low-risk, helps ALL strategies)
Several §2 rules map directly to Argus screening knobs and would tighten anti-rug for every
strategy, not just the candidate:

| EvilPanda rule | Argus knob | Change |
|----------------|-----------|--------|
| top10 < 16% | `maxTop10Pct` (have `top10_pct`) | tighten (Meridian was 62) |
| TVL/mcap ≤ 5 | **NEW** — compute `tvl / mcap` | add a screening filter |
| fees ≥ 30 (wash) | `minFeeActiveTvlRatio` / fee floor | raise / add a global-fee floor |
| volume ≥ 1M, mcap ≥ 250k | `minVolume`, `minMcap` | align |
| age 6h–1wk | `minTokenAgeHours`/`maxTokenAgeHours` | set band |
| bundle / zero-buy | `bundle_pct`, `bot_holders_pct` | tighten gates |
| bubble-map clusters | **NEW** — Argus has no holder-cluster analysis | future (needs on-chain holder graph) |

**The TVL/mcap ≤ 5 rule is the most novel & valuable** — Argus doesn't have it, it's cheap to
compute, and it directly detects the "lured into providing exit liquidity" trap.

### Track B — the `wide_range` candidate strategy (dry-run shadow)
A 4th scan pipeline Argus simulates but never gates live on:
- geometry: single-sided SOL, **wide** `rangePct` (e.g. 0.5–0.9)
- entry: `supertrend_or_rsi` confirmed
- exit: `bb_plus_rsi` exit (RSI/BB) + `max_hold` (until MACD technique exists)
- screening: the §2 anti-rug profile (tightest of all strategies)
- learn its **net-P&L distribution** vs bid_ask/limit_order in the same conditions

---

## 5. P&L simulation feasibility
- Wide-range single-sided IL + fee harvest → `computeSingleSidedPnlPct` + `computeSimulatedFeePct`
  already fit (pass a wide `rangeFraction`).
- ⚠️ **fee cap (10pp)** may under-credit the fee-harvest edge — raise per-strategy for `wide_range`.
- Exit needs indicator-driven (Supertrend/RSI/BB) detection during the hold — approximate with
  `net_target`/`max_hold` until indicator-exits land.

---

## 6. EvilPanda on AI agents (he names Meridian) — and what it means for us

He explicitly **advises against** AI agents like **Meridian** for *live* management:
*"their strategies are not fixed and can become unpredictable/chaotic."* His workflow instead:
**use AI to analyze daily PnL → find improvements → HARD-CODE them as fixed, stable rules.**

This is not a dismissal of our approach — it's a sharp articulation of the **right division of
labor**, and it validates the direction we're already taking:
- **Argus = the analysis brain** (find edges from real PnL/technique data) — exactly his "use AI to analyze PnL".
- **Meridian = execution** — should apply *validated, stable* rules, not thrash live.
- This is **Phase 6 done right**: technique/strategy edges are validated via dry-run + the live
  feedback loop, then applied **deliberately** (promote/hard-code), not chaotically re-tuned every cycle.

Takeaway: keep Argus as the *deliberate* learner that proposes stable improvements; avoid
letting any live executor constantly mutate its own rules. Our promotion-gated, shadow-first,
human-in-the-loop tuning model is aligned with his critique.

---

## 7. Validation path
Dry-run shadow only → register `wide_range` strategy + `evilpanda` author → measure net-P&L
**distribution** (not win-rate; asymmetric payoff) in trend/froth buckets → graduate only on a
real, distribution-aware edge → if Meridian runs a real version, live feedback attributes the
edge to `evilpanda` (Phase 5).

---

## 8. Remaining data gaps (lower priority)
- Exact Supertrend params (ATR period/multiplier) — not stated.
- Exact bin count / bin-step per range — "up to 90%" is the headline, granularity unspecified.
- Bubble-map cluster detection needs an on-chain holder graph Argus doesn't have yet.
