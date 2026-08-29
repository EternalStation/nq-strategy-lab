# NQ Strategy Lab

A local-first strategy-testing workstation for CME E-mini Nasdaq-100 futures.

## What is included

- TradingView Lightweight Charts candlesticks with configurable canvas, candle colors, and grids; chart time is fixed to New York
- Databento `GLBX.MDP3` continuous front-month NQ importer
- One-minute Parquet storage with derived 5m, 15m, and 1h intervals
- One-minute candles are the default chart, backtest, and optimizer timeframe
- Strategy library and readable rule inspector
- Per-strategy hidden execution assumptions (currently 1 MNQ contract, $2.25 commission per side, 1 tick slippage)
- Custom date ranges plus a one-click full-history range
- Backtest metrics including trades, win rate, dollar drawdown, profit factor, and average trade
- A capped 3,000-bar chart window, including 500 future bars around focused trades, independent of full-range backtesting
- Clickable executions, previous/next trade controls, and exact New York-time chart jumps
- Paginated trade table, interactive clickable equity curve, and data-quality coverage panels
- No Wick Body trend/retracement strategy with explicit pending-order, stop, target, and same-bar rules
- No Wick Body V2 wick-only rolling-limit strategy, independent of trend and range measurement
- 08:12–09:12 New York range-break and inverse-FVG strategy with wick/close breakout modes
- A 500-test optimizer covering candle direction, New York time blocks, trend, stop, and reward-to-risk settings
- Sortable top-20 result views for every column, a global bottom-five comparison, and a parameter P&L histogram
- A single-job optimizer guard: only the selected strategy can optimize, concurrent optimizer requests are rejected, and the active Python job can be stopped from the Optimizer tab

## Local setup

The project is already configured in this workspace. For a fresh machine:

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Add the Databento API key to `.env`. The file is ignored by Git.

## Data management

Every historical request can be priced before downloading:

```powershell
.\.venv\Scripts\python.exe -m scripts.data_cli range
.\.venv\Scripts\python.exe -m scripts.data_cli quote --start 2010-06-06T00:00:00Z --end 2026-08-28T22:15:00Z
.\.venv\Scripts\python.exe -m scripts.data_cli download --start 2010-06-06T00:00:00Z --end 2026-08-28T22:15:00Z --max-cost 18
.\.venv\Scripts\python.exe -m scripts.data_cli conditions --start 2010-06-06 --end 2026-08-28
.\.venv\Scripts\python.exe -m scripts.data_cli build
```

The downloader writes to a temporary path first and only replaces the active Parquet file after a successful transfer. The configured cost ceiling is an additional safety check.

## Run the application

Start the API:

```powershell
.\.venv\Scripts\python.exe -m uvicorn server.main:app --reload --host 127.0.0.1 --port 8000
```

Start the frontend in a second terminal:

```powershell
npm run dev
```

Open `http://127.0.0.1:5173`.

## Futures handling

The imported symbol is `NQ.v.0`, Databento's volume-based front contract. Prices remain unadjusted across rolls. The stored `instrument_id` lets future strategy work distinguish contracts and identify rollover transitions.

Higher intervals are derived from the stored one-minute bars. This keeps the chart and tester on the same source instead of mixing vendor aggregates.

## Adding a strategy

New strategy implementations belong in `server/backtest.py`, with their visible rule descriptions registered in `src/App.tsx`. Keep execution timing explicit, including signal bar, fill bar, session timezone, stop and target priority, commissions, slippage, sizing, and rollover behavior.

### No Wick Body execution model

- Bullish and bearish trends are classified from the configured directional-candle count; dojis count as neither direction.
- The same lookback defines a high-low range. Long limits must be at or below the configured fraction of that range, while short limits must be at or above it.
- A wickless setup creates a limit at the candle low in an uptrend or high in a downtrend. The order activates on the next bar.
- The wickless signal can be filtered to trend-direction candles, counter-trend candles, or both.
- Only one pending order or open position is allowed. An unfilled limit is canceled when its trend classification changes or its permitted New York entry window ends.
- Entries are restricted to the selected New York window. The normal strategy uses 00:00–15:00; optimization also tests 04:00–06:00, 08:00–10:00, 10:00–12:00, and 12:00–14:00. A position already open may exit after its entry window.
- Stop distance and reward-to-risk are parameterized. If a bar touches both stop and target, the backtest uses the conservative stop-first result.
- The optimizer evaluates 500 unique settings from even lookbacks 12–30, thresholds 60–80%, directional Fibonacci gates 25%, 37.5%, 50%, 62.5%, and 75%, a dynamic confirmed three-candle swing stop plus fixed stops from 15–50 points, reward-to-risk 1:2–1:5, and the entry windows above. Both bullish and bearish wickless candles are always eligible. A swing stop uses the latest pivot at least five bars older than the setup and adds four points beyond it. The optimizer retains the union of each metric's top 20, while the table shows the best 20 for the currently sorted column. Its DD / Net metric divides maximum drawdown by positive net P&L; lower percentages are better. Selecting a result runs its full trades and equity curve.
- P&L uses MNQ economics: $2 per index point and $0.50 per tick. Positions are flattened at 16:00 New York using the 16:00 bar open, or the last available bar close if that timestamp is missing.
- The Trade outcome tab plots the signed active streak after every closed trade and reports the longest win and loss sequences. Clicking the chart focuses that trade.
- Focused trades show the exact rolling range used by the strategy, including range high, range low, and the selected fractional gate.

### No Wick Body V2 execution model

- V2 is one-minute only and has no trend, directional-candle, or range/retracement filter. A lower-wickless candle creates a long limit at the body low; an upper-wickless candle creates a short limit at the body high. Candle colour does not affect eligibility.
- A candle with neither wick is skipped, because its simultaneous long and short limits cannot be ordered reliably from one-minute OHLC data.
- The order first becomes eligible after the selected number of complete intervening candles (0–5). A later wickless signal replaces an unfilled limit.
- The optimizer tests fixed stops from 1–5 points, targets from 1:3 to 1:10 in 0.5R steps, delay from 0–5 bars, and expiry after 5–20 bars or at the next wickless signal. It retains a representative 500-combination sample from the 7,650-combination space, while covering the full value ranges.
- Signals and fills are allowed from 20:00 through 15:59 New York. Pending limits do not cross the 16:00 close; remaining positions flatten at the 16:00 candle open. Stop-first handling applies when a candle reaches both stop and target.

### Range iFVG execution model

- The strategy is one-minute only. Each complete New York day uses all 61 candles from 08:12 through 09:12, inclusive, to establish the range; incomplete ranges are skipped.
- The first strict break of the range high or low selects the direction. The configurable trigger is either a wick beyond the level (default) or a candle close beyond it. A bar that breaks both sides is skipped because its intrabar order is unknown.
- A high break watches bullish three-candle fair value gaps and enters short on the first later close below the first candle's high. A low break watches bearish gaps and enters long on the first later close above the first candle's low. FVG candles must be consecutive one-minute bars.
- Entry is the inversion candle close. The stop is the most extreme high or low from the breakout through entry, and the target is the opposite range boundary. Any wick through that target boundary before entry invalidates the setup.
- Entries are allowed only after the range is complete, from 09:13 through 11:59 New York. Only one entry is allowed per New York day and positions cannot overlap. Stops and targets become active on the candle after entry. If both are touched in one candle, the stop wins. Any remaining position is flattened at the 12:00 New York candle open (or the last available pre-noon close when that candle is missing).
- Focused trades chart the measured range, breakout, FVG bounds, inversion entry, recent-extreme stop anchor, stop, and target.
- Its optimizer runs two otherwise identical variants—wick breakout and one-minute body-close breakout—and exposes both the comparison table and breakout parameter chart.

## Legacy data caveat

Databento's CME history before May 21, 2017 comes from a legacy FIX/FAST backfill. On some of those dates, one-minute OHLCV activity is folded into far fewer bars than the intervals that actually traded, which can produce sparse evening-only sessions and an abnormally large bar. This is a source-data normalization limitation rather than a real two-hour NQ session or a local import error.

The 00:00–15:00 New York entry filter prevents the No Wick Body strategy from trading the folded evening bars. Missing intraday bars still cannot be reconstructed from this OHLCV source, so results spanning affected dates should be interpreted with that limitation in mind.
