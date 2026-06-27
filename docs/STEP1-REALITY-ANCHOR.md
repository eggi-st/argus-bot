# STEP 1 — Re-anchor Argus's confidence to REALITY (Design, REVIEW DRAFT)

Status: **design only.** Internal to Argus (dry-run) → **nol risiko trading.** Prasyarat
sebelum loop saran Argus→Meridian. Created 2026-06-27.

## 1. Tujuan
Buat `pattern_library` (dasar confidence Argus) mencerminkan **outcome NYATA Meridian**
(`feedback_outcomes`, 428 close), bukan cuma dry-run **simulasi** yang terbukti optimis.
Hasil: confidence Argus bisa dipercaya → loop saran nanti aman.

## 2. Kondisi saat ini (hasil analisa kode)
- Confidence decision = skor screener × `pattern_library` (via `adjustScore` + `checkPatternGate`).
- `pattern_library` (sumber otoritatif = `reconcile.js`) dibangun **HANYA dari `dry_run_positions`**
  (SIM), JOIN decisions, grouped (condition_bucket→vol×regime, strategy). [reconcile.js:20-29]
- Outcome **nyata Meridian** yang tak punya dry-run row = **sengaja DI-DROP** ("unlinked, not in
  source"). [reconcile.js:31-37] → 428 outcome nyata **diabaikan** learner.
- Sim terbukti optimis: dry-run avg **+5.47% / 79% WR** vs realita **−0.10% / 60% WR**.
- `feedback_outcomes` SUDAH cocok untuk di-key-kan: 190 bid_ask + 238 spot, ~semua punya
  `condition_bucket` + `pnl_pct` + `win` + `strategy`. (spot_lo: 0 di backup ini.)

➡️ **Confidence Argus = berbasis simulasi optimis. Data nyata yang sudah ada tidak dipakai.**

## 3. Desain: reconcile "real-preferred"
Per kunci (vol_bucket × regime × strategy), bangun DUA rollup lalu pilih:

```
SIM rollup   : FROM dry_run_positions JOIN decisions  (seperti sekarang)
REAL rollup  : FROM feedback_outcomes                 (baru) — group by condition_bucket+strategy
               (win = win, mean = AVG(pnl_pct), n = COUNT)

Pilih per kunci:
  jika REAL_n >= minRealSamples (mis. 10):  pakai REAL  → source='real'
  selain itu:                                pakai SIM   → source='sim' (UNVERIFIED)
```

**Prinsip:** realita menang di mana realita ada; sim hanya pengisi sementara untuk
kondisi yang belum pernah ditradingkan nyata — dan ditandai `unverified`.

## 4. Perubahan schema `pattern_library` (additive, ALTER)
Tambah kolom (pertahankan yang lama):
```sql
ALTER TABLE pattern_library ADD COLUMN source            TEXT;     -- 'real' | 'sim'
ALTER TABLE pattern_library ADD COLUMN live_win_rate     REAL;     -- dari feedback_outcomes
ALTER TABLE pattern_library ADD COLUMN live_mean_pnl     REAL;
ALTER TABLE pattern_library ADD COLUMN live_sample_count INTEGER DEFAULT 0;
ALTER TABLE pattern_library ADD COLUMN sim_win_rate      REAL;     -- dari dry_run (arsip/perbandingan)
ALTER TABLE pattern_library ADD COLUMN sim_sample_count  INTEGER DEFAULT 0;
ALTER TABLE pattern_library ADD COLUMN reality_gap       REAL;     -- live_wr − sim_wr (transparansi)
```
`win_rate`/`mean_pnl_net`/`sample_count` (kolom efektif yang dibaca confidence) =
salinan dari REAL (kalau dipilih) atau SIM (fallback). Kompatibel mundur: kode lama yang
baca `win_rate` tetap jalan, sekarang nilainya reality-based di mana ada data nyata.

## 5. Perubahan confidence (`adjustScore` / gate)
- Pattern `source='real'` → dipakai penuh (seperti sekarang, tapi kini reality-based).
- Pattern `source='sim'` (unverified) → **didiskon**: confidence dari pola sim dikalikan
  `simConfidenceDiscount` (mis. 0.7) ATAU diperlakukan sebagai "calibrating" (tidak mem-boost,
  hanya netral). Supaya bot tidak yakin berlebihan pada kondisi yang baru disimulasikan.
- `checkPatternGate` (Wilson lower bound) tetap — sekarang beroperasi di WR nyata.

## 6. spot_lo (jaga konsistensi)
`feedback_outcomes.strategy='spot_lo'` **TIDAK** dimasukkan ke pattern_library `spot`
(sesuai keputusan lama: jaga learner spot bersih). Map: hanya `bid_ask` + `spot` murni
yang masuk. spot_lo tetap di feedback_outcomes untuk atribusi, bukan pattern.

## 7. Transparansi reality_gap
- Simpan `reality_gap` per pola → tampilkan di halaman Patterns (badge "real"/"sim" +
  gap). Pola yang sim-optimis (gap besar negatif) terlihat jelas.
- Selaras dengan `/api/techniques/performance` reality_gap (per-teknik) yang sudah ada.

## 8. Interaksi dengan kalibrasi fee + candidate_score
- **Kalibrasi fee (cap 3 + haircut 0.5):** untuk kondisi yang masih fallback-SIM, sim baru
  akan realistis (close pasca-deploy). Jadi STEP 1 + kalibrasi saling melengkapi: real-preferred
  menutup yang ada datanya; sim terkalibrasi mengisi sisanya dengan lebih jujur.
- **candidate_score:** itu gate sisi **Meridian** (anti-prediktif, C3) — bukan bagian
  pattern_library Argus. Pisahkan jadi cleanup config Meridian tersendiri (keputusan Anda).

## 9. Rollout & verifikasi (nol risiko trading)
Argus = dry-run; mengubah confidence hanya mengubah posisi **simulasi** mana yang dibuka —
**tidak menyentuh uang nyata.** Tetap hati-hati & terukur:
1. Implementasi additive (kolom baru, reconcile diperluas) — tidak menghapus jalur lama.
2. **Verifikasi:** jalankan reconcile → cek `pattern_library`: untuk bucket yang punya data
   nyata, `win_rate` = WR nyata feedback_outcomes (mis. spot real ~56-63%), `source='real'`,
   `reality_gap` masuk akal. Bucket tanpa data nyata → `source='sim'` + terdiskon.
3. Bandingkan jumlah pola active sebelum/sesudah (harusnya lebih sedikit yang over-confident).
4. Karena nol risiko, bisa diuji penuh di dry-run lokal sebelum VPS.

## 10. Risiko & mitigasi
| Risiko | Mitigasi |
|---|---|
| Sampel nyata per-bucket kecil → noisy | `minRealSamples` (≥10) + Wilson LB tetap dipakai |
| Blend sim+real menyesatkan | TIDAK di-blend — real-preferred (pilih salah satu), gap disimpan |
| spot_lo mencemari learner spot | Dikecualikan eksplisit |
| Pola sim lama tetap over-confident | Diskon `source='sim'` + kalibrasi fee untuk sim baru |
| Regresi diam-diam | Additive + verifikasi reconcile + reversible (kolom lama utuh) |

## 11. Perubahan kode (ringkas)
- `src/db/schema.js`: 7 ALTER kolom + perluas `recordPatternReconciled` menerima field baru.
- `src/learning/reconcile.js`: tambah REAL rollup dari `feedback_outcomes`, logika real-preferred,
  isi kolom live/sim/source/reality_gap, kecualikan spot_lo.
- `src/intelligence/index.js`: `adjustScore`/gate diskon `source='sim'` (knob `learning.simConfidenceDiscount`).
- `src/config.js`: `learning.minRealSamples` (10), `learning.simConfidenceDiscount` (0.7).
- UI Patterns: badge source + reality_gap.

## 12. Keputusan untuk Anda
1. `minRealSamples` ambang real-preferred (default 10)?
2. `simConfidenceDiscount` untuk pola sim (default 0.7) — atau perlakukan sim sebagai netral total (0 boost)?
3. Apakah sekaligus **reset/expire** dry-run lama yang dihitung model fee lama, supaya sim baru
   (terkalibrasi) menggantikannya lebih cepat? (opsional)

## 13. Urutan besar
STEP 1 (ini, nol risiko) → confidence reality-based → baru STEP 2 (shadow suggestion loop) →
STEP 3 (live). Relates: [[meridian-profitability-state]], [[argus-technique-architecture]],
dan dokumen `ARGUS-MERIDIAN-SUGGESTION-LOOP.md`.
