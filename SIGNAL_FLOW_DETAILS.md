# XAUUSD Signal Flow Details

This document explains what happens after you fetch candles, when a signal appears on the chart, and where to inspect every important value.

## Quick Summary

The app does not create a BUY or SELL marker just because price moves.

A signal appears on the chart only after:

1. Real candles are fetched from the server API.
2. Candles are normalized, de-duplicated, sorted, and filtered.
3. Market structure is calculated.
4. Market context is calculated.
5. A Phase 4 setup reaches `TRIGGER`.
6. Phase 5 finds a valid closed confirmation candle.
7. SL, TP, RR, and final signal score are valid.
8. No future candle is used.

Pending or rejected candidates are shown in debug panels, not as fake chart signals.

## Main Files

| Area | File |
| --- | --- |
| Main app flow | `app/components/market-chart-app.tsx` |
| Candle API client | `lib/candles/api-client.ts` |
| Server candle provider | `lib/server/candle-provider.ts` |
| API route | `app/api/candles/route.ts` |
| Candle normalization | `lib/candles/utils.ts` |
| Chart | `app/components/candlestick-chart.tsx` |
| Market structure | `lib/market-structure/engine.ts` |
| Market context | `lib/market-context/engine.ts` |
| Setup scanner | `lib/setup-scanner/engine.ts` |
| Signal engine | `lib/entry-engine/engine.ts` |
| Signal types | `lib/entry-engine/types.ts` |
| Signal debug UI | `app/components/signal-debug-panel.tsx` |
| Signal funnel UI | `app/components/signal-funnel-panel.tsx` |
| Signal history UI | `app/components/signal-history-table.tsx` |
| Backtest engine | `lib/backtesting/engine.ts` |

## Fetch Inputs

The chart form sends this request to the backend:

```json
{
  "symbol": "XAUUSD",
  "timeframe": "5m",
  "startDate": "2026-05-20T00:00",
  "endDate": "2026-05-23T00:00"
}
```

Supported timeframe options in the UI:

```text
1m, 5m, 15m, 1h
```

The frontend never calls Finage directly. It calls:

```text
POST /api/candles
```

The server route then calls the external candle provider using the API key from `.env.local`.

## Environment Setup

Use `.env.local`:

```bash
CANDLE_API_PROVIDER=finage
CANDLE_API_KEY=your_finage_key
CANDLE_API_MAX_POINTS=30000
```

Do not put the API key in frontend code.

## What Happens After Fetch

### 1. User Clicks Fetch

File:

```text
app/components/market-chart-app.tsx
```

Function:

```text
handleFetch()
```

The app validates:

- Symbol is required.
- Timeframe is required.
- Start date is required.
- End date is required.
- Start date must be before end date.

Then it:

- Cancels any previous in-flight request.
- Shows loading state.
- Clears old candles and old selected signals.
- Calls `fetchCandles()`.

### 2. Server API Fetches Candles

Frontend calls:

```text
lib/candles/api-client.ts
```

Server route:

```text
app/api/candles/route.ts
```

Provider:

```text
lib/server/candle-provider.ts
```

The server:

- Reads `CANDLE_API_KEY` from environment.
- Builds the Finage request.
- Supports large ranges with chunking/pagination logic.
- Uses request cache by symbol, timeframe, start date, and end date.
- Returns raw candle data and cache/fetch metadata.

### 3. Raw Candles Are Normalized

File:

```text
lib/candles/utils.ts
```

Normalized candle shape:

```ts
{
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime?: number;
  isClosed: boolean;
}
```

Normalization rules:

- Convert numeric values safely.
- Reject invalid candles.
- Keep only valid OHLC values.
- Remove duplicates by timestamp using `Map`.
- Sort by timestamp ascending.
- Ignore future candles.
- Keep closed candles when possible.

### 4. Data Audit Is Built

The audit panel shows:

- Selected symbol
- Timeframe
- Start and end date
- Raw candles fetched
- Valid candle count
- Invalid count
- Duplicate count
- First candle time
- Last candle time
- Missing gap count
- Fetch duration
- Cache hit or miss

This is Phase 1 data foundation.

## Chart Rendering

The chart receives `chartCandles`, which are normalized and date-filtered candles.

The chart displays:

- Candlesticks
- Time axis
- Price axis
- Crosshair
- Tooltip with OHLC
- Visible range
- Market structure overlays
- Setup overlays
- Confirmed signal overlays
- Entry, stop, and target levels for selected signals

Important:

Only confirmed `TradeSignal` objects are drawn as signal markers.

Pending candidates, expired candidates, invalidated candidates, and rejected candidates do not create BUY or SELL markers.

## Full Signal Pipeline

### Phase 1: Candle Data

Input:

```text
raw API candles
```

Output:

```text
normalized closed candles
```

If there are no valid candles:

```text
No chart signal can exist.
```

### Phase 2: Market Structure

File:

```text
lib/market-structure/engine.ts
```

Calculates:

- Swing highs
- Swing lows
- BSL zones
- SSL zones
- Sweeps
- Displacement candles
- Buyers pressure
- Sellers pressure
- BOS
- CHOCH
- MSS
- FVG zones
- ATR

Important:

BUYERS and SELLERS markers are pressure markers only. They are not trade signals.

### Phase 3: Market Context

File:

```text
lib/market-context/engine.ts
```

Calculates:

- LTF, ITF, HTF mapping
- HTF bias
- ITF setup state
- Premium/discount location
- Nearest key levels
- Session quality
- Volatility state
- Market regime
- Wait state

If context is `WAIT`, strict modes can reject otherwise valid-looking setups.

### Phase 4: Setup Scanner

File:

```text
lib/setup-scanner/engine.ts
```

Setup states:

```text
WATCH -> SETUP -> TRIGGER -> INVALIDATED / EXPIRED
```

Phase 4 does not create BUY or SELL signals.

It only creates market setups, such as:

- Liquidity sweep reversal
- Trend continuation
- Compression breakout
- Range reversal

A setup must reach `TRIGGER` before Phase 5 can evaluate it for a signal.

### Phase 5: Entry Signal Engine

File:

```text
lib/entry-engine/engine.ts
```

This is where confirmed BUY/SELL signals are created.

Phase 5 checks:

- Setup reached `TRIGGER`
- Direction is bullish or bearish
- Setup score is high enough
- Confirmation candle exists
- Confirmation candle is closed
- Reversal risk is acceptable
- Stop loss is valid
- Take profit is valid
- RR is high enough
- Final signal score is high enough
- No future data is used

## When A Signal Appears On The Chart

A chart signal appears only when Phase 5 returns a `TradeSignal`.

Signal types:

```text
CONFIRMED_BUY
CONFIRMED_SELL
RAPID_BUY
RAPID_SELL
```

Required fields on a confirmed signal:

```ts
{
  id: string;
  type: "CONFIRMED_BUY" | "CONFIRMED_SELL" | "RAPID_BUY" | "RAPID_SELL";
  direction: "BULLISH" | "BEARISH";
  status: "CONFIRMED" | "ACTIVE" | "INVALIDATED" | "TP_HIT" | "SL_HIT" | "EXPIRED";
  sourceSetupId: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  rr: number;
  score: number;
  confirmedAtIndex: number;
  timestamp: number;
  noRepaintProof: object;
}
```

Chart display:

- BUY signal appears for bullish confirmed signal.
- SELL signal appears for bearish confirmed signal.
- Entry price line can be shown.
- Stop loss line can be shown.
- Take profit line can be shown.
- Hover/select shows signal details.

## Pending Confirmation Logic

Config:

```ts
{
  confirmationWindowCandles: 3 // default
}
```

Mode-specific override:

```text
NORMAL_SCALP confirmation window = 2 closed candles
CALIBRATION / EASY_SCALP / PRO_TRADER confirmation window = 3 closed candles
```

If a trigger exists but a valid confirmation candle does not exist yet:

```text
PENDING_CONFIRMATION
```

This means:

- No BUY/SELL marker is created.
- Candidate is shown in debug.
- The app waits up to the mode's configured closed-candle window.

If confirmation appears within the configured window:

```text
CONFIRMED
```

If confirmation does not appear within the configured window:

```text
EXPIRED_CONFIRMATION
```

If price closes beyond invalidation before confirmation:

```text
INVALIDATED
```

## Trigger Candle Can Confirm

The trigger candle itself can be used as confirmation if it is already closed and strong.

For BUY:

- Candle is closed.
- Candle closes bullish.
- Close is near the high.
- Candle breaks minor structure or reacts from setup zone.
- Reversal risk is not HIGH.
- SL, TP, and RR are valid.

For SELL:

- Candle is closed.
- Candle closes bearish.
- Close is near the low.
- Candle breaks minor structure or reacts from setup zone.
- Reversal risk is not HIGH.
- SL, TP, and RR are valid.

No unclosed candle is used.

No future candle is used.

## Score Thresholds

Phase 4 setup score and Phase 5 final signal score are separate.

| Mode | Required Setup Score | Required Final Signal Score | Minimum RR |
| --- | ---: | ---: | ---: |
| `CALIBRATION` | 45 | 50 | 1.0 |
| `EASY_SCALP` | 55 | 55 | 1.2 |
| `NORMAL_SCALP` | 55 | 60 | 1.5 |
| `PRO_TRADER` | 75 | 80 | 2.0 |

Example:

```text
Setup score = 60
NORMAL setup requirement = 55
```

This setup is allowed to continue into Phase 5.

Then Phase 5 calculates final signal score:

```text
setup score contribution
+ confirmation candle quality
+ RR quality
+ SL/TP quality
+ session/context quality
+ volatility quality
+ anti-reversal quality
```

So a setup score of 66 can still become a valid NORMAL signal if confirmation, RR, and trade quality are strong enough.

## Final Signal Score Components

The final score is built from:

| Component | Meaning |
| --- | --- |
| `phase4Setup` | Contribution from Phase 4 setup score |
| `contextAlignment` | HTF/context alignment |
| `confirmationCandle` | Quality of closed confirmation candle |
| `stopLossQuality` | Stop distance and structural quality |
| `targetQuality` | TP and RR quality |
| `sessionQuality` | Session participation |
| `volatilityQuality` | Volatility condition |
| `antiReversal` | Reversal risk quality |

If final score is too low:

```text
Rejected because final score 57 is below NORMAL SCALP requirement 60.
```

## Candidate Debug Output

Every pending, expired, invalidated, or rejected candidate includes:

```ts
{
  setupId: string;
  setupScore: number;
  requiredSetupScore: number;
  finalSignalScore: number | null;
  requiredSignalScore: number;
  confirmationStatus:
    | "CONFIRMED"
    | "PENDING_CONFIRMATION"
    | "EXPIRED_CONFIRMATION"
    | "INVALIDATED"
    | "REJECTED";
  confirmationWindowRemaining: number;
  rejectionReason: string;
  nextRequiredAction: string;
}
```

Examples:

```text
Waiting for confirmation candle. 2 candles remaining.
```

```text
Rejected because confirmation window expired.
```

```text
Rejected because final score 57 is below NORMAL SCALP requirement 60.
```

```text
Stop tracking this candidate because price closed beyond the setup invalidation level before confirmation.
```

## Signal Debug Panel

Panel:

```text
Signal Debug
```

Shows:

- Candles scanned
- Markers generated
- Contexts generated
- Phase 4 setups
- Trigger setups found
- Pending confirmation count
- Expired confirmation count
- Invalidated candidate count
- Confirmed BUY count
- Confirmed SELL count
- Rejected count
- Minimum setup score
- Minimum signal score
- Minimum RR
- Last rejection
- RR calculation
- SL source
- TP source
- Candidate debug table
- No-repaint warnings

Use this panel when you want to know why a chart signal did or did not appear.

## Signal Funnel Panel

Panel:

```text
Signal Funnel
```

Shows the full pipeline count:

- Total candles
- Valid closed candles
- LTF candles
- ITF candles
- HTF candles
- Swings
- Liquidity zones
- Sweeps
- Displacements
- BOS/CHOCH/MSS
- FVG
- WATCH/SETUP/TRIGGER counts
- Pending confirmation count
- Expired confirmation count
- Invalidated candidate count
- Confirmed BUY/SELL count
- Rejected count
- Backtest trade count

It also shows:

- Top rejection reasons
- Full history scan range
- Gold price unit diagnostics
- Last 20 trigger setup diagnostics

The "Last 20 Trigger Setup Diagnostics" table is the fastest place to inspect:

- Setup score
- Required setup score
- Final signal score
- Required signal score
- Confirmation status
- Confirmation window remaining
- Entry candidate
- SL
- TP
- RR
- Rejection reason
- Next required action

## Signal History Table

Panel:

```text
Signal History
```

Shows confirmed signals only.

It does not show pending/rejected candidates because those are not trade signals.

Columns include:

- Date/time
- Symbol
- Timeframe
- Mode
- Signal type
- Direction
- Entry
- SL
- TP1, TP2, TP3
- RR
- Score
- Confidence
- Session
- Setup type
- Strategy model
- Status
- Reason
- Warnings

Clicking a row selects that signal on the chart.

## Backtesting

Backtest uses confirmed signals only.

It ignores:

- Pending candidates
- Expired confirmation candidates
- Invalidated candidates
- Rejected candidates

If no trades exist:

```text
No trades found. Backtest cannot calculate win rate. Check Signal Funnel.
```

Backtest uses:

- Entry
- Stop loss
- Take profit
- RR
- Signal timestamp
- Confirmation index
- No-repaint proof

## No-Repaint Rules

A confirmed signal includes `noRepaintProof`.

The signal is valid only if:

- Confirmation candle is closed.
- Evidence indexes are at or before confirmation index.
- Trigger index is at or before confirmation index.
- Context used by signal is available at confirmation time.
- Trade levels are fixed after confirmation.

If future evidence is detected, the signal is rejected.

## What You See In The Chart

### If Data Fetch Fails

You see:

```text
Error state
```

No chart update happens.

### If No Candles Return

You see:

```text
No-data state
```

No signal engine runs on empty data.

### If Candles Load But No Setup Triggers

You see:

```text
Candlestick chart only
```

Signal Funnel says Phase 4 is blocking.

### If Setup Triggers But Confirmation Is Missing

You see:

```text
No BUY/SELL marker yet
```

Signal Debug and Signal Funnel show:

```text
PENDING_CONFIRMATION
```

### If Confirmation Appears

You see:

```text
BUY or SELL signal marker
```

Signal History gets a row.

Backtest can use the signal.

### If Confirmation Expires

You see:

```text
No BUY/SELL marker
```

Signal Debug shows:

```text
EXPIRED_CONFIRMATION
```

### If Price Invalidates First

You see:

```text
No BUY/SELL marker
```

Signal Debug shows:

```text
INVALIDATED
```

## Latest Verified Sample

Sample request:

```json
{
  "symbol": "XAUUSD",
  "timeframe": "5m",
  "startDate": "2026-05-20T00:00",
  "endDate": "2026-05-23T00:00"
}
```

Verified after the latest signal-engine fix:

```text
Raw candles: 864
Valid candles: 864
Phase 4 setups: 141
Phase 4 triggers: 48
No-future setup validation: pass
```

Mode results from that sample:

| Mode | Confirmed | BUY | SELL | Pending | Expired Confirmation | Invalidated Candidates | Rejected | Trades |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `CALIBRATION` | 27 | 26 | 1 | 0 | 1 | 14 | 21 | 6 |
| `EASY_SCALP` | 0 | 0 | 0 | 0 | 4 | 14 | 48 | 0 |
| `NORMAL_SCALP` | 8 | 7 | 1 | 0 | 5 | 14 | 40 | 4 |
| `PRO_TRADER` | 0 | 0 | 0 | 0 | 4 | 14 | 48 | 0 |

Important:

`NORMAL_SCALP` is no longer blocked just because setup score is 66 and old minimum was 75.

Now `NORMAL_SCALP` uses:

```text
required setup score = 55
required final signal score = 60
minimum RR = 1.5
confirmation window = 2 closed candles
```

If it still rejects a setup, the reason is now a real Phase 5 reason such as:

- Choppy market
- Confirmation did not qualify
- Invalidated before confirmation
- RR too low
- Final score too low
- SL or TP invalid
- Context filter

## How To Run

```bash
pnpm dev
```

Current dev URL:

```text
http://localhost:3015
```

Run checks:

```bash
pnpm test
pnpm lint
pnpm build
```

## Safety Rules

The app must not:

- Create BUY/SELL from unclosed candles.
- Create BUY/SELL from pending candidates.
- Use future candles.
- Convert pressure markers into trade signals.
- Treat Phase 4 setup as a trade by itself.
- Backtest rejected/pending candidates.
- Expose the Finage API key in frontend code.

The app can:

- Show pending/rejected candidates in debug panels.
- Show confirmed signals on chart.
- Backtest confirmed signals.
- Explain exactly why a candidate did not become a signal.

## Practical Reading Guide

When you fetch data and do not see a signal:

1. Open `Signal Funnel`.
2. Check `Trigger Setup Count`.
3. If triggers are zero, Phase 4 is blocking.
4. If triggers exist but confirmed signals are zero, Phase 5 is blocking.
5. Look at `Top Rejection Reasons`.
6. Look at `Last 20 Trigger Setup Diagnostics`.
7. Read `confirmationStatus`.
8. Read `nextRequiredAction`.

When you see a signal on the chart:

1. Select or hover the signal.
2. Check entry, SL, TP, RR, score, and confidence.
3. Check `Signal Debug` for score breakdown.
4. Check `No repaint` message.
5. Check `Signal History` for all confirmed signal fields.
6. Check `Backtest Dashboard` to see if that signal became a trade.
