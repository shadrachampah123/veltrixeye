# Market-Data Licensing (Twelve Data) — M2 Verification Record

**Verified:** 2026-09-13 (pre-implementation gate for M2).
**Reviewer:** VeltrixEye engineering (Arena agent session).
**Sources:** [Twelve Data Terms of Use](https://twelvedata.com/terms),
[Commercial and personal usage](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage),
[US equities market data](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data),
[Attribution guidelines](https://support.twelvedata.com/en/articles/12647398-attribution-guidelines-for-using-twelve-data),
[Business pricing](https://twelvedata.com/pricing-business).

This document records the licensing conclusion that M2 is built on. If any
statement below stops matching Twelve Data's published terms, M2's market-data
operation must pause until the terms are re-verified.

## Intended VeltrixEye use (what was checked)

| # | Intended use | Verdict |
|---|---|---|
| 1 | Storing historical OHLCV candles server-side (Postgres `candles` table) | **Permitted.** ToS §2.2(a) grants the right to "access, receive, process, and **store Data**" (§2.2(a)). Bounded by §16.1 (retain only for the subscription duration, plus regulatory needs) and §2.3(g) (not beyond timeframes in the Documentation — no shorter public limit was found on 2026-09-13). Our retention (max 5y daily) sits inside the vendor's own availability windows. |
| 2 | Displaying candle/market data to authenticated SaaS users (Markets UI, charts, tables) | **Permitted on a Business plan.** ToS §2.2(b) permits display "to Authorized Users … or third parties **as expressly permitted by your Subscription Tier**". Business plans "allow the use of data for **commercial display** and internal usage" (support article). Individual plans explicitly do **not** permit commercial display. |
| 3 | Using stored data to generate derived trading signals later (M3+ engine, setups, scores, alerts) | **Permitted with one constraint.** ToS §2.2(c) permits creating "Derived Data that **cannot be reverse-engineered to recreate the original Data**", and §6.2 confirms "Customer retains rights to Derived Data created in compliance". Setup detections, quality scores, and alert text are aggregates — compliant. We must never expose a raw or losslessly reconstructable OHLCV series as "derived". |
| 4 | Letting users download / re-share raw data (CSV export, user-facing data API) | **NOT permitted** without a Redistribution Rights Add-On or separate agreement (ToS §2.2(e), §2.3(b)). **M2 ships no export of raw market data** — display only. |

## Required plan

| Environment | Plan | Why |
|---|---|---|
| Local dev / CI | Individual (Basic free, or Grow/Pro paid) | Personal/internal use only: building and testing ingestion. No user-facing display. |
| **Production SaaS** | **Business — Venture or higher** (Venture from $149/mo; featured tier $499/mo; 17% off annual; startup discount available) | The lowest tier whose license includes **external display** ("ideal for companies showcasing data on client-facing apps or websites"). |
| Later, if users can download/bulk-export raw data | Enterprise ($1,099/mo, "external distribution") or a Redistribution Rights Add-On | Only needed if redistribution is ever added — explicitly out of M2 scope. |

Exchange fees: none apply to M2's scope. US historical equities (≥1 day old)
carry no exchange display fees; FX/crypto/spot gold are OTC with no exchange
licensing at all — only Twelve Data's own terms govern. US real-time display
would need exchange entitlements later (M3+ live work, not M2).

## Instrument-licensing consequence: SPX500 removed from M2

Raw S&P 500 index values require a **separate index-data license from
S&P Dow Jones** (filed product agreements show ~$10,000/yr minimums; ETF-scale
fees are far higher). No Twelve Data self-serve tier conveys S&P index display
rights, so `index/SPX500` is **excluded from the M2 ingestion universe**: it
keeps its M1 identifier row (no data deleted) but receives no provider-symbol
mapping and no candles. `etf/SPY` (already in the universe) covers US
large-cap exposure for scanner purposes. Re-adding a real index feed requires
its own license — tracked as future work, not M2.

## Fallback provider status (EODHD)

EODHD is the approved **fallback** (deep cheap history, clear B2B ladder from
$399/mo internal commercial). It is **not implemented in M2**. Before any
fallback implementation, verify with EODHD: (a) XAUUSD intraday availability,
(b) commercial-display terms for our exact use, (c) their storage/retention
rules. The `MarketDataProvider` interface + `instrument_provider_symbols`
model mean adding it later is additive.

## Operational rules derived from the terms

1. Production must run on **Venture or higher** before any user can see market
   data. A production deploy on an Individual key is a license violation for
   display — the deployment runbook gates on this.
2. **No raw-data export** in M2 (no CSV download, no user-facing candle API
   beyond the authenticated UI's own reads). The UI reads are display, not
   redistribution.
3. **Attribution**: Markets UI carries a "Market data by Twelve Data" line.
   (Required for redistributed/API integrations; good practice for display.)
4. **Retention caps are licensing hygiene**: the store prunes beyond the
   documented retention table (see `docs/market-data.md`), keeping stored
   data inside vendor availability windows.
5. Derived-signal work (M3+) must preserve the non-reverse-engineerability
   property: aggregates, grades, and alerts — never raw series replay.

## Re-verify triggers

Re-check this document (and pause market-data operation if it no longer holds)
whenever any of these occurs:

- Twelve Data publishes new Terms of Use / pricing / support-licensing text.
- We sign the production Venture (or higher) contract — confirm the order
  form's tier text matches this record.
- We add user-facing raw-data export, redistribution, white-label, or
  real-time display.
- We add a second provider or change the instrument universe.
- 12 months elapse without review (next review due: 2027-09-13).
