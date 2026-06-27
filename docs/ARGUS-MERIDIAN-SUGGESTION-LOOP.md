# Argus → Meridian Suggestion Loop — Design (REVIEW DRAFT)

Status: **design only, not implemented.** Rollout is **shadow-first** (zero trading risk
until explicitly graduated to live). Created 2026-06-27.

## 1. Tujuan
Argus menyarankan pool kandidat ke Meridian. Meridian **tetap memvalidasi ulang** dengan
screening-nya sendiri, lalu **terima (alasan jelas)** atau **tolak (alasan jelas)**.
Argus = lapisan saran; Meridian = penentu akhir. Argus tidak pernah men-trigger deploy.

## 2. Kondisi saat ini (hasil analisa kode)
Seluruh kontrak SUDAH ada — yang hilang cuma **pemanggilan**:

| Komponen | Status |
|---|---|
| Argus `GET /api/meridian/recommendations` (daftar decision aktif, urut confidence) | ✅ ada (`getActiveRecommendations`) |
| Argus `GET /api/meridian/pool/:addr/signal` (sinyal per-pool) | ✅ ada (`getPoolSignal`) |
| Meridian `checkArgusSignal(pool)` (pull per-pool, fail-safe → null) | ✅ ada — **TAPI 0 call site** |
| Meridian `pushOutcomeToArgus()` (lapor hasil) | ✅ aktif |
| Config Meridian `argus{enabled,url,signalThreshold:0.65,blockOnLowConfidence:false}` | ✅ ada |

**Kesimpulan:** integrasi sekarang **satu arah** (Meridian→Argus hasil saja). Meridian
**tidak pernah menanyakan saran Argus sebelum deploy.** Hanya 1 decision "followed" + 2
outcome ter-link dari 428 (kebetulan, bukan disengaja).

## 3. Dua model (kita pakai B, sesuai permintaan)
- **Model A — Validate/boost:** Meridian scan kandidatnya sendiri → tanya Argus per-pool →
  pakai confidence Argus sebagai gate/boost tambahan. (Argus memvalidasi kandidat Meridian.)
- **Model B — Suggest + re-validate (PILIHAN):** Meridian tarik daftar saran Argus →
  tambah sebagai kandidat → **re-validasi penuh lewat screening Meridian** → terima/tolak
  dengan alasan. (Argus mengusulkan pool yang mungkin Meridian lewatkan.)

A dan B bisa hidup berdampingan nanti; tahap awal fokus **B**.

## 4. Alur (Model B)
```
Tiap scan Meridian:
  1. PULL  → GET {argus}/api/meridian/recommendations?strategy=spot,spot_lo
             (fail-safe: error/timeout → [] → Meridian jalan normal tanpa Argus)
  2. FILTER STRATEGI → buang saran yang strateginya bukan {spot, spot_lo}
  3. FILTER CONFIDENCE + TTL → confidence ≥ minConfidence & belum expired
  4. DEDUP → buang pool yang sudah dipegang / baru saja diproses / dalam cooldown
  5. RE-VALIDASI → tiap pool usulan lewat getRejectReason() Meridian (screening penuh:
     anti-rug, umur, tvl/mcap, holders, dst.) + cek risk-limit (maxPositions, circuit
     breaker, cooldown)
  6. KEPUTUSAN + LOG (alasan jelas):
       lolos semua → ACCEPT  (shadow: catat "would deploy"; live: deploy)
       gagal salah satu → REJECT (catat alasan persis dari getRejectReason / risk-limit)
  7. (live saja) deploy pakai sizing & risk Meridian sendiri — Argus TIDAK pengaruhi ukuran
```

## 5. Aturan keamanan (NON-NEGOTIABLE)
1. **Saran = kandidat tambahan, BUKAN bypass.** Wajib lolos `getRejectReason()` + risk-limit
   Meridian yang sama persis. Tidak ada jalur pintas.
2. **Jangan pakai P&L simulasi Argus** sebagai dasar. Dry-run Argus terbukti optimis
   (+5~9% vs realita ~0%). Dasar saran = confidence dari kondisi screener + reality_gap,
   bukan angka sim. (Confidence Argus harus berbasis outcome nyata.)
3. **Risk tetap milik Meridian.** Ukuran posisi, maxPositions, circuit breaker, cooldown,
   stop-loss, fresh-stop — Argus tak boleh menyentuh.
4. **Strategy whitelist** = {spot, spot_lo} (config). Saran strategi lain dibuang.
5. **TTL/freshness** — hormati `expires_at`; pool basi dibuang.
6. **Fail-safe** — Argus mati/lambat → daftar kosong → Meridian deploy normal seperti
   tanpa Argus. Integrasi tidak boleh memblok jalur trading.
7. **Idempoten/dedup** — satu pool tak boleh memicu deploy ganda.

## 6. Rollout shadow-first (pola yang sama dengan fresh-stop / whale-veto)
- **Fase 0 — shadow (LOG-ONLY, nol risiko):**
  `argus.suggestMode = "shadow"`. Jalankan langkah 1–6, tapi langkah ACCEPT hanya
  **mencatat** "would deploy (alasan)" / REJECT "alasan" ke `logs/argus-suggest-YYYY-MM-DD.jsonl`.
  TIDAK deploy apa pun.
- **Evaluasi (data-driven, bukan kalender):** setelah cukup sampel, ukur:
  - Berapa saran Argus yang **lolos** re-validasi Meridian? (kalau hampir semua ditolak →
    saran Argus tak menambah nilai / screener Meridian sudah menangkapnya)
  - Dari yang lolos, apakah pool itu **akhirnya menguntungkan**? (cocokkan ke outcome nyata
    via feedback_outcomes / lessons.json)
  - Apakah Argus mengusulkan pool **bagus yang Meridian lewatkan**? (nilai unik utama)
  - Kriteria graduate (usulan awal): ≥ 30 saran ACCEPT dalam shadow, dan win-rate pool
    ACCEPT ≥ baseline Meridian, dan ≥ beberapa "missed-by-Meridian" yang profit.
- **Fase 1 — live:** kalau terbukti menambah edge, set `suggestMode = "live"`. Mulai dengan
  batas konservatif (mis. maxSuggestionDeploysPerScan = 1).
- **Kill-switch:** `suggestMode = "off"` atau `argus.enabled=false` → mati total, instan.

## 7. Logging (auditability — "alasan jelas")
`logs/argus-suggest-YYYY-MM-DD.jsonl`, satu baris per saran yang dievaluasi:
```json
{ "ts":"...", "pool":"...", "token":"...", "argus_strategy":"spot",
  "argus_confidence":0.71, "argus_bucket":"medium_vol_neutral",
  "decision":"ACCEPT|REJECT|SKIP", "reason":"passed all screens | antirug: age=24h | maxPositions full | not in whitelist",
  "revalidation":"passed|failed", "mode":"shadow|live", "deployed":false }
```
Surface di web UI Meridian (halaman Experiment, di samping shadow/whale-veto) + ringkasan:
"N saran · X accept · Y reject (alasan teratas)".

## 8. Config baru (Meridian `argus`)
```jsonc
"argus": {
  "enabled": true,
  "url": "http://localhost:4000",
  "suggestMode": "shadow",              // off | shadow | live   (DEFAULT shadow saat rilis)
  "suggestStrategyWhitelist": ["spot","spot_lo"],
  "suggestMinConfidence": 0.65,         // selaras signalThreshold
  "maxSuggestionDeploysPerScan": 1,     // batas konservatif saat live
  "signalThreshold": 0.65,              // (model A, opsional nanti)
  "blockOnLowConfidence": false         // (model A, opsional nanti)
}
```

## 9. Perubahan kode yang dibutuhkan
**Argus (kecil):**
- `getActiveRecommendations()` + endpoint terima query `?strategy=spot,spot_lo` (filter) +
  pastikan confidence/threshold ada. (Sudah 90% jadi.)
- (Opsional) tandai decision yang ditarik sebagai "suggested_to_meridian" untuk audit.

**Meridian (utama, di review branch):**
- Modul baru `argus-suggest.js`: pull daftar → filter strategi/conf/TTL → dedup → re-validasi
  via `getRejectReason()` + risk-limit → tulis log accept/reject.
- Hook di scan loop (sesudah screening kandidat sendiri, sebelum/awal fase deploy).
- `suggestMode` gating: shadow = log saja; live = deploy (lewat jalur deploy + risk yang ada).
- Endpoint status `/api/argus-suggest` + tampilan di Experiment page.

## 10. Failure modes & mitigasi
| Risiko | Mitigasi |
|---|---|
| Argus salah usul pool jelek | Re-validasi penuh Meridian (gate sama) → ditolak + dicatat |
| Argus down | Fail-safe → [] → Meridian normal |
| P&L sim menyesatkan | Tidak dipakai; dasar = confidence kondisi nyata + reality_gap |
| Over-deploy | maxPositions + maxSuggestionDeploysPerScan + circuit breaker |
| Pool basi | TTL `expires_at` |
| Deploy ganda | dedup pool aktif/cooldown |
| Regresi diam-diam | shadow-first + log + graduate by data |

## 11. Keputusan yang perlu Anda ambil
1. **Confidence Argus** saat ini berasal dari skor screener + pattern_library (campur sim).
   Untuk aman, perlu di-recalibrate ke outcome nyata dulu? (rekomendasi: ya, atau minimal
   tandai confidence yang belum tervalidasi.)
2. **Threshold** awal `suggestMinConfidence` (default 0.65 — sama signalThreshold).
3. **Model A juga?** (Argus mem-boost/validate kandidat Meridian sendiri) — atau B saja dulu.
4. **Graduate criteria** angka pastinya (default usulan di §6).

## 12. Ringkas
- Pipa sudah ada; tinggal wiring + shadow-logic + log.
- Shadow-first = **nol risiko** sampai terbukti.
- Meridian selalu penentu akhir; Argus tak pernah bypass screening/risk.
- Relates: [[meridian-profitability-state]], [[argus-technique-architecture]].
