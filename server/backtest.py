from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from typing import Any, Callable

import numpy as np
import pandas as pd

from .models import BacktestRequest, OptimizationRequest


# MNQ uses one tenth of the NQ contract multiplier while sharing the same
# underlying index price series.
POINT_VALUE = 2.0
TICK_VALUE = 0.5
SWING_MIN_SETUP_GAP = 5
SWING_STOP_BUFFER_POINTS = 4.0
SESSION_CLOSE_MINUTE = 16 * 60
IFVG_RANGE_START_MINUTE = 8 * 60 + 12
IFVG_RANGE_END_MINUTE = 9 * 60 + 12
IFVG_FLATTEN_MINUTE = 12 * 60
OPTIMIZER_LOOKBACKS = tuple(range(12, 31, 2))
OPTIMIZER_THRESHOLDS = (0.60, 0.65, 0.70, 0.75, 0.80)
OPTIMIZER_STOP_CONFIGS = (
    ("swing", 15.0),
    *(("fixed", float(points)) for points in range(15, 51, 5)),
)
OPTIMIZER_REWARDS = tuple(np.arange(2.0, 5.01, 0.5).tolist())
OPTIMIZER_TIME_WINDOWS = ((0, 15), (4, 6), (8, 10), (10, 12), (12, 14))
OPTIMIZER_RANGE_FRACTIONS = (0.25, 0.375, 0.5, 0.625, 0.75)
V2_ENTRY_START_MINUTE = 20 * 60
V2_ENTRY_END_MINUTE = 16 * 60
V2_STOP_POINTS = tuple(float(points) for points in range(1, 6))
V2_REWARDS = tuple(np.arange(3.0, 10.01, 0.5).tolist())
V2_ENTRY_DELAYS = tuple(range(0, 6))
V2_EXPIRY_CONFIGS = (
    *(("bars", bars) for bars in range(5, 21)),
    ("next_signal", 5),
)


class OptimizationCancelled(Exception):
    """Raised when the active optimizer has been stopped by the user."""


@dataclass
class NoWickContext:
    opens: np.ndarray
    highs: np.ndarray
    lows: np.ndarray
    closes: np.ndarray
    trend: np.ndarray
    trend_run_end: np.ndarray
    candidates: np.ndarray
    range_low: np.ndarray
    range_high: np.ndarray
    ny_minute: np.ndarray
    ny_day: np.ndarray
    session_close_index: np.ndarray
    latest_swing_low_index: np.ndarray
    latest_swing_high_index: np.ndarray


@dataclass
class NoWickV2Context:
    opens: np.ndarray
    highs: np.ndarray
    lows: np.ndarray
    closes: np.ndarray
    candidate_indices: np.ndarray
    candidate_sides: np.ndarray
    ny_minute: np.ndarray
    session_close_index: np.ndarray


def run_strategy(df: pd.DataFrame, request: BacktestRequest) -> dict[str, Any]:
    if request.strategy_id == "no-wick-body":
        return run_no_wick_body(df, request)
    if request.strategy_id == "range-ifvg":
        if request.timeframe != "1m":
            raise ValueError("Range iFVG requires the 1-minute timeframe")
        return run_range_ifvg(df, request)
    if request.strategy_id == "no-wick-body-v2":
        if request.timeframe != "1m":
            raise ValueError("No Wick Body V2 requires the 1-minute timeframe")
        return run_no_wick_body_v2(df, request)
    raise ValueError(f"Unknown strategy: {request.strategy_id}")


@dataclass(frozen=True)
class FairValueGap:
    first_index: int
    created_index: int
    low: float
    high: float
    inversion_level: float


def build_no_wick_context(
    df: pd.DataFrame, trend_lookback: int, trend_threshold: float
) -> NoWickContext:
    opens = df["open"].to_numpy(dtype=float, copy=False)
    highs = df["high"].to_numpy(dtype=float, copy=False)
    lows = df["low"].to_numpy(dtype=float, copy=False)
    closes = df["close"].to_numpy(dtype=float, copy=False)
    count = len(df)

    bullish = closes > opens
    bearish = closes < opens
    bull_cumulative = np.concatenate(([0], np.cumsum(bullish, dtype=np.int32)))
    bear_cumulative = np.concatenate(([0], np.cumsum(bearish, dtype=np.int32)))
    bull_counts = bull_cumulative[trend_lookback:] - bull_cumulative[:-trend_lookback]
    bear_counts = bear_cumulative[trend_lookback:] - bear_cumulative[:-trend_lookback]
    required = int(np.ceil(trend_lookback * trend_threshold - 1e-12))

    trend = np.zeros(count, dtype=np.int8)
    start = trend_lookback - 1
    trend[start:][bull_counts >= required] = 1
    trend[start:][bear_counts >= required] = -1

    # These are the same bars used for the trend classification. The signal
    # candle is the final bar in the rolling range.
    range_low = (
        df["low"].rolling(trend_lookback, min_periods=trend_lookback).min()
        .to_numpy(dtype=float, copy=False)
    )
    range_high = (
        df["high"].rolling(trend_lookback, min_periods=trend_lookback).max()
        .to_numpy(dtype=float, copy=False)
    )

    # Exact exchange prices are quarter-point aligned. The tiny tolerance only
    # protects comparisons after conversion to floating point.
    tolerance = 1e-8
    no_bottom_wick = np.abs(lows - np.minimum(opens, closes)) <= tolerance
    no_top_wick = np.abs(highs - np.maximum(opens, closes)) <= tolerance
    candidates = np.flatnonzero(
        ((trend == 1) & no_bottom_wick) | ((trend == -1) & no_top_wick)
    )

    latest_swing_low_index = np.full(count, -1, dtype=np.int64)
    latest_swing_high_index = np.full(count, -1, dtype=np.int64)
    if count >= 3:
        swing_low_centers = np.flatnonzero(
            (lows[1:-1] < lows[:-2]) & (lows[1:-1] < lows[2:])
        ) + 1
        swing_high_centers = np.flatnonzero(
            (highs[1:-1] > highs[:-2]) & (highs[1:-1] > highs[2:])
        ) + 1
        low_updates = np.full(count, -1, dtype=np.int64)
        high_updates = np.full(count, -1, dtype=np.int64)
        low_confirmation = swing_low_centers + 2
        high_confirmation = swing_high_centers + 2
        low_valid = low_confirmation < count
        high_valid = high_confirmation < count
        low_updates[low_confirmation[low_valid]] = swing_low_centers[low_valid]
        high_updates[high_confirmation[high_valid]] = swing_high_centers[high_valid]
        latest_swing_low_index = np.maximum.accumulate(low_updates)
        latest_swing_high_index = np.maximum.accumulate(high_updates)
    ny_time = pd.to_datetime(df["ts_event"], utc=True).dt.tz_convert(
        "America/New_York"
    )
    ny_minute = (ny_time.dt.hour * 60 + ny_time.dt.minute).to_numpy(
        dtype=np.int16, copy=False
    )
    ny_day = (
        ny_time.dt.year * 10_000 + ny_time.dt.month * 100 + ny_time.dt.day
    ).to_numpy(dtype=np.int32, copy=False)

    session_close_index = np.empty(count, dtype=np.int64)
    if count:
        day_starts = np.concatenate(
            ([0], np.flatnonzero(ny_day[1:] != ny_day[:-1]) + 1)
        )
        day_ends = np.concatenate((day_starts[1:], [count]))
        for day_start, day_end in zip(day_starts, day_ends, strict=True):
            context_minutes = ny_minute[day_start:day_end]
            close_relative = int(
                np.searchsorted(
                    context_minutes,
                    SESSION_CLOSE_MINUTE,
                    side="left",
                )
            )
            if (
                close_relative < context_minutes.size
                and context_minutes[close_relative] == SESSION_CLOSE_MINUTE
            ):
                close_index = int(day_start + close_relative)
            elif close_relative > 0:
                close_index = int(day_start + close_relative - 1)
            else:
                close_index = int(day_start)
            session_close_index[day_start:day_end] = close_index

    if count:
        run_starts = np.concatenate(
            ([0], np.flatnonzero(trend[1:] != trend[:-1]) + 1)
        )
        run_ends = np.concatenate((run_starts[1:] - 1, [count - 1]))
        trend_run_end = np.repeat(run_ends, run_ends - run_starts + 1)
    else:
        trend_run_end = np.array([], dtype=np.int64)

    return NoWickContext(
        opens=opens,
        highs=highs,
        lows=lows,
        closes=closes,
        trend=trend,
        trend_run_end=trend_run_end,
        candidates=candidates,
        range_low=range_low,
        range_high=range_high,
        ny_minute=ny_minute,
        ny_day=ny_day,
        session_close_index=session_close_index,
        latest_swing_low_index=latest_swing_low_index,
        latest_swing_high_index=latest_swing_high_index,
    )


def _first_true(values: np.ndarray) -> int | None:
    matches = np.flatnonzero(values)
    return int(matches[0]) if matches.size else None


def _directional_range_level(
    side: int, range_low: float, range_high: float, fraction: float
) -> float:
    span = range_high - range_low
    return (
        range_high - span * fraction
        if side == 1
        else range_low + span * fraction
    )


def _find_position_exit(
    context: NoWickContext,
    entry_index: int,
    side: int,
    stop_price: float,
    target_price: float,
    end_index_exclusive: int,
) -> tuple[int, bool] | None:
    # Search in bounded blocks. Most NQ exits occur quickly; comparing against
    # the entire remaining multi-year array for every trade is needlessly
    # quadratic on long backtests.
    block_size = 4_096
    search_end = min(end_index_exclusive, context.closes.size)
    for block_start in range(entry_index, search_end, block_size):
        block_end = min(block_start + block_size, search_end)
        if side == 1:
            stop_hits = context.lows[block_start:block_end] <= stop_price
            target_hits = context.highs[block_start:block_end] >= target_price
        else:
            stop_hits = context.highs[block_start:block_end] >= stop_price
            target_hits = context.lows[block_start:block_end] <= target_price
        exit_relative = _first_true(stop_hits | target_hits)
        if exit_relative is not None:
            return block_start + exit_relative, bool(stop_hits[exit_relative])
    return None


def _no_wick_metrics(
    pnl_values: list[float], max_drawdown: float, initial_capital: float
) -> dict[str, Any]:
    if not pnl_values:
        return empty_result(initial_capital)["metrics"]
    pnls = np.asarray(pnl_values, dtype=float)
    wins = pnls[pnls > 0]
    losses = pnls[pnls < 0]
    profit_factor = float(wins.sum() / abs(losses.sum())) if losses.size else float("inf")
    return {
        "net_pnl": round(float(pnls.sum()), 2),
        "total_trades": int(pnls.size),
        "win_rate": round(float((pnls > 0).mean() * 100), 2),
        "max_drawdown": round(max_drawdown, 2),
        "profit_factor": round(profit_factor, 2) if np.isfinite(profit_factor) else None,
        "average_trade": round(float(pnls.mean()), 2),
        "ending_equity": round(float(initial_capital + pnls.sum()), 2),
    }


def _execution_candidates(
    context: NoWickContext, request: BacktestRequest
) -> tuple[np.ndarray, np.ndarray]:
    if request.trade_start_hour >= request.trade_end_hour:
        raise ValueError("Trade start hour must be earlier than trade end hour")

    base_candidates = context.candidates
    candidate_trend = context.trend[base_candidates]
    range_low = context.range_low[base_candidates]
    range_high = context.range_high[base_candidates]
    range_span = range_high - range_low
    candidate_entry = np.where(
        candidate_trend == 1,
        context.lows[base_candidates],
        context.highs[base_candidates],
    )
    valid_range = np.isfinite(range_span) & (range_span > 1e-8)
    directional_depth = np.divide(
        np.where(
            candidate_trend == 1,
            range_high - candidate_entry,
            candidate_entry - range_low,
        ),
        range_span,
        out=np.full(candidate_entry.shape, np.nan, dtype=float),
        where=valid_range,
    )
    range_match = valid_range & (
        directional_depth >= request.range_fraction - 1e-12
    )

    start_minute = request.trade_start_hour * 60
    end_minute = request.trade_end_hour * 60
    eligible = (
        (context.ny_minute >= start_minute) & (context.ny_minute < end_minute)
    )
    candidates = base_candidates[
        range_match & eligible[base_candidates]
    ]

    # A pending order cannot survive the end of its New York entry window or
    # carry into the next calendar day.
    new_day = np.concatenate(
        ([False], context.ny_day[1:] != context.ny_day[:-1])
    )
    window_boundaries = np.flatnonzero((~eligible) | new_day)
    return candidates, window_boundaries


def simulate_no_wick_body(
    df: pd.DataFrame,
    request: BacktestRequest,
    context: NoWickContext,
    include_details: bool,
) -> dict[str, Any]:
    count = len(df)
    if count < request.trend_lookback + 1 or not context.candidates.size:
        return empty_result(request.initial_capital)
    candidates, window_boundaries = _execution_candidates(context, request)
    if not candidates.size:
        return empty_result(request.initial_capital)

    fixed_stop_distance = float(request.stop_points)
    per_trade_cost = request.contracts * (
        2 * request.commission_per_side
        + 2 * request.slippage_ticks_per_side * TICK_VALUE
    )
    equity = float(request.initial_capital)
    peak_equity = equity
    max_drawdown = 0.0
    pnl_values: list[float] = []
    trades: list[dict[str, Any]] = []
    equity_points: list[dict[str, Any]] = []
    timestamps = df["ts_event"] if include_details else None
    search_from = request.trend_lookback - 1

    while search_from < count:
        candidate_position = int(np.searchsorted(candidates, search_from))
        if candidate_position >= candidates.size:
            break
        setup_index = int(candidates[candidate_position])
        side = int(context.trend[setup_index])
        entry_price = (
            float(context.lows[setup_index])
            if side == 1
            else float(context.highs[setup_index])
        )

        # The limit becomes active on the next bar and remains active only for
        # the uninterrupted run of the same trend classification.
        trend_end = int(context.trend_run_end[setup_index])
        boundary_position = int(np.searchsorted(window_boundaries, setup_index + 1))
        window_end = (
            int(window_boundaries[boundary_position] - 1)
            if boundary_position < window_boundaries.size
            else count - 1
        )
        pending_end = min(trend_end, window_end)
        fill_start = setup_index + 1
        if fill_start > pending_end:
            search_from = pending_end + 1
            continue
        if side == 1:
            fill_relative = _first_true(
                context.lows[fill_start : pending_end + 1] <= entry_price
            )
        else:
            fill_relative = _first_true(
                context.highs[fill_start : pending_end + 1] >= entry_price
            )
        if fill_relative is None:
            search_from = pending_end + 1
            continue
        entry_index = fill_start + fill_relative

        if request.stop_mode == "swing":
            # A pivot centered five or more bars before the no-wick setup is
            # confirmed no later than setup_index - 3. Looking up the pivot at
            # that confirmation cutoff both enforces the age rule and prevents
            # a later pivot from replacing the intended stop anchor while the
            # limit order is pending.
            pivot_lookup_index = setup_index - SWING_MIN_SETUP_GAP + 2
            if pivot_lookup_index < 0:
                search_from = entry_index + 1
                continue
            pivot_index = int(
                context.latest_swing_low_index[pivot_lookup_index]
                if side == 1
                else context.latest_swing_high_index[pivot_lookup_index]
            )
            if (
                pivot_index < 0
                or setup_index - pivot_index < SWING_MIN_SETUP_GAP
            ):
                search_from = entry_index + 1
                continue
            stop_price = (
                float(context.lows[pivot_index]) - SWING_STOP_BUFFER_POINTS
                if side == 1
                else float(context.highs[pivot_index]) + SWING_STOP_BUFFER_POINTS
            )
            stop_distance = abs(entry_price - stop_price)
            if stop_distance <= 0 or (side == 1 and stop_price >= entry_price) or (
                side == -1 and stop_price <= entry_price
            ):
                search_from = entry_index + 1
                continue
        else:
            pivot_index = -1
            stop_distance = fixed_stop_distance
            stop_price = entry_price - side * stop_distance
        target_distance = stop_distance * float(request.reward_risk)
        target_price = entry_price + side * target_distance
        session_close_index = int(context.session_close_index[entry_index])
        exit_match = _find_position_exit(
            context,
            entry_index,
            side,
            stop_price,
            target_price,
            session_close_index,
        )

        if exit_match is None:
            exit_index = session_close_index
            if context.ny_minute[exit_index] >= SESSION_CLOSE_MINUTE:
                exit_price = float(context.opens[exit_index])
            else:
                exit_price = float(context.closes[exit_index])
            exit_reason = "Session close"
            finished = exit_index >= count - 1
        else:
            exit_index, stopped = exit_match
            # When both levels occur in the same OHLC bar, use the conservative
            # stop-first assumption because intrabar ordering is unavailable.
            if stopped:
                exit_price = stop_price
                exit_reason = "Stop loss"
            else:
                exit_price = target_price
                exit_reason = "Take profit"
            finished = False

        gross = (
            (exit_price - entry_price) * side * POINT_VALUE * request.contracts
        )
        pnl = gross - per_trade_cost
        equity += pnl
        peak_equity = max(peak_equity, equity)
        max_drawdown = max(max_drawdown, peak_equity - equity)
        pnl_values.append(pnl)

        if include_details and timestamps is not None:
            entry_time = pd.Timestamp(timestamps.iloc[entry_index])
            exit_time = pd.Timestamp(timestamps.iloc[exit_index])
            setup_time = pd.Timestamp(timestamps.iloc[setup_index])
            range_start_index = setup_index - request.trend_lookback + 1
            range_start_time = pd.Timestamp(timestamps.iloc[range_start_index])
            setup_range_low = float(context.range_low[setup_index])
            setup_range_high = float(context.range_high[setup_index])
            setup_range_level = _directional_range_level(
                side,
                setup_range_low,
                setup_range_high,
                float(request.range_fraction),
            )
            trade_id = f"T{len(trades) + 1:05d}"
            trades.append(
                {
                    "id": trade_id,
                    "side": "long" if side == 1 else "short",
                    "entry_time": entry_time.isoformat(),
                    "exit_time": exit_time.isoformat(),
                    "entry_price": round(entry_price, 2),
                    "exit_price": round(exit_price, 2),
                    "stop_price": round(stop_price, 2),
                    "target_price": round(target_price, 2),
                    "stop_mode": request.stop_mode,
                    "stop_distance": round(stop_distance, 2),
                    "swing_index": pivot_index if pivot_index >= 0 else None,
                    "swing_age_bars": (
                        setup_index - pivot_index if pivot_index >= 0 else None
                    ),
                    "swing_time": (
                        pd.Timestamp(timestamps.iloc[pivot_index]).isoformat()
                        if pivot_index >= 0
                        else None
                    ),
                    "swing_price": (
                        round(
                            float(
                                context.lows[pivot_index]
                                if side == 1
                                else context.highs[pivot_index]
                            ),
                            2,
                        )
                        if pivot_index >= 0
                        else None
                    ),
                    "setup_time": setup_time.isoformat(),
                    "range_start_time": range_start_time.isoformat(),
                    "range_end_time": setup_time.isoformat(),
                    "range_low": round(setup_range_low, 2),
                    "range_high": round(setup_range_high, 2),
                    "range_fraction": float(request.range_fraction),
                    "range_level": round(setup_range_level, 2),
                    "contracts": request.contracts,
                    "gross_pnl": round(gross, 2),
                    "pnl": round(pnl, 2),
                    "duration_minutes": max(
                        1, int((exit_time - entry_time).total_seconds() // 60)
                    ),
                    "exit_reason": exit_reason,
                }
            )
            equity_points.append(
                {
                    "time": int(exit_time.timestamp()),
                    "value": round(equity, 2),
                    "trade_id": trade_id,
                    "trade_number": len(trades),
                    "net_pnl": round(pnl, 2),
                }
            )

        if finished:
            break
        # A setup on the exit candle may create the next order at that close.
        search_from = exit_index

    return {
        "metrics": _no_wick_metrics(
            pnl_values, max_drawdown, request.initial_capital
        ),
        "trades": list(reversed(trades)) if include_details else [],
        "equity_curve": equity_points if include_details else [],
    }


def run_no_wick_body(df: pd.DataFrame, request: BacktestRequest) -> dict[str, Any]:
    context = build_no_wick_context(
        df, request.trend_lookback, request.trend_threshold
    )
    return simulate_no_wick_body(df, request, context, include_details=True)


def build_no_wick_v2_context(df: pd.DataFrame) -> NoWickV2Context:
    """Build the wick-only signal and New York-session context for V2."""
    opens = df["open"].to_numpy(dtype=float, copy=False)
    highs = df["high"].to_numpy(dtype=float, copy=False)
    lows = df["low"].to_numpy(dtype=float, copy=False)
    closes = df["close"].to_numpy(dtype=float, copy=False)
    count = len(df)
    tolerance = 1e-8
    no_bottom_wick = np.abs(lows - np.minimum(opens, closes)) <= tolerance
    no_top_wick = np.abs(highs - np.maximum(opens, closes)) <= tolerance

    # A full-body candle has neither wick and would create contradictory long
    # and short limits at the same close. It is deliberately skipped instead
    # of assigning an arbitrary direction.
    long_signal = no_bottom_wick & ~no_top_wick
    short_signal = no_top_wick & ~no_bottom_wick
    candidate_indices = np.flatnonzero(long_signal | short_signal)
    candidate_sides = np.where(long_signal[candidate_indices], 1, -1).astype(
        np.int8, copy=False
    )

    ny_time = pd.to_datetime(df["ts_event"], utc=True).dt.tz_convert(
        "America/New_York"
    )
    ny_minute = (ny_time.dt.hour * 60 + ny_time.dt.minute).to_numpy(
        dtype=np.int16, copy=False
    )
    session_close_index = np.full(count, max(0, count - 1), dtype=np.int64)
    if count:
        # The V2 trading day starts at 20:00 New York and flattens at 16:00.
        # Evening bars therefore belong to the following calendar day's close.
        session_close_date = (ny_time + pd.to_timedelta(
            (ny_minute >= V2_ENTRY_START_MINUTE).astype(np.int8), unit="D"
        )).dt.strftime("%Y%m%d").to_numpy(copy=False)
        calendar_date = ny_time.dt.strftime("%Y%m%d").to_numpy(copy=False)
        close_by_day: dict[str, int] = {}
        for index, (day, minute) in enumerate(zip(calendar_date, ny_minute, strict=True)):
            if minute == V2_ENTRY_END_MINUTE:
                close_by_day[str(day)] = index
        # If a dataset is missing the exact 16:00 candle, retain the last bar
        # before 16:00 as the conservative available close for that day.
        for index, (day, minute) in enumerate(zip(calendar_date, ny_minute, strict=True)):
            if minute < V2_ENTRY_END_MINUTE and str(day) not in close_by_day:
                close_by_day[str(day)] = index
        for index, close_day in enumerate(session_close_date):
            close_index = close_by_day.get(str(close_day))
            if close_index is not None and close_index >= index:
                session_close_index[index] = close_index

    return NoWickV2Context(
        opens=opens,
        highs=highs,
        lows=lows,
        closes=closes,
        candidate_indices=candidate_indices,
        candidate_sides=candidate_sides,
        ny_minute=ny_minute,
        session_close_index=session_close_index,
    )


def _v2_entry_eligible(ny_minute: np.ndarray) -> np.ndarray:
    return (ny_minute >= V2_ENTRY_START_MINUTE) | (ny_minute < V2_ENTRY_END_MINUTE)


def simulate_no_wick_body_v2(
    df: pd.DataFrame,
    request: BacktestRequest,
    context: NoWickV2Context,
    include_details: bool,
) -> dict[str, Any]:
    """Execute V2's non-trend, one-pending-limit rules.

    A new wickless signal replaces an unfilled limit. The delay is measured in
    complete bars between setup and first eligible fill bar: delay=1 skips the
    next candle and activates on the candle after it.
    """
    count = len(df)
    if count < 2 or not context.candidate_indices.size:
        return empty_result(request.initial_capital)
    eligible = _v2_entry_eligible(context.ny_minute)
    candidates = context.candidate_indices[eligible[context.candidate_indices]]
    if not candidates.size:
        return empty_result(request.initial_capital)
    side_by_index = np.zeros(count, dtype=np.int8)
    side_by_index[context.candidate_indices] = context.candidate_sides

    per_trade_cost = request.contracts * (
        2 * request.commission_per_side
        + 2 * request.slippage_ticks_per_side * TICK_VALUE
    )
    equity = float(request.initial_capital)
    peak_equity = equity
    max_drawdown = 0.0
    pnl_values: list[float] = []
    trades: list[dict[str, Any]] = []
    equity_points: list[dict[str, Any]] = []
    timestamps = df["ts_event"] if include_details else None
    search_from = 0

    while search_from < count:
        candidate_position = int(np.searchsorted(candidates, search_from))
        if candidate_position >= candidates.size:
            break
        setup_index = int(candidates[candidate_position])
        side = int(side_by_index[setup_index])
        entry_price = (
            float(context.lows[setup_index])
            if side == 1
            else float(context.highs[setup_index])
        )
        session_close_index = int(context.session_close_index[setup_index])
        fill_start = setup_index + int(request.v2_entry_delay_bars) + 1
        if request.v2_order_expiry_mode == "bars":
            expiry_index = setup_index + int(request.v2_order_expiry_bars)
        else:
            expiry_index = count - 1
        next_candidate = (
            int(candidates[candidate_position + 1])
            if candidate_position + 1 < candidates.size
            else count
        )
        # A newer setup always supersedes a still-pending limit. The
        # next-signal option simply removes the fixed age ceiling.
        pending_end = min(
            expiry_index,
            next_candidate - 1,
            session_close_index - 1,
            count - 1,
        )
        if fill_start > pending_end:
            search_from = min(next_candidate, max(search_from + 1, pending_end + 1))
            continue
        fill_slice = slice(fill_start, pending_end + 1)
        fills = (
            context.lows[fill_slice] <= entry_price
            if side == 1
            else context.highs[fill_slice] >= entry_price
        )
        fill_relative = _first_true(fills)
        if fill_relative is None:
            search_from = min(next_candidate, pending_end + 1)
            continue
        entry_index = fill_start + fill_relative
        stop_distance = float(request.v2_stop_points)
        stop_price = entry_price - side * stop_distance
        target_price = entry_price + side * stop_distance * float(request.v2_reward_risk)
        exit_match = _find_position_exit(
            context, entry_index, side, stop_price, target_price, session_close_index
        )
        if exit_match is None:
            exit_index = session_close_index
            exit_price = (
                float(context.opens[exit_index])
                if context.ny_minute[exit_index] == V2_ENTRY_END_MINUTE
                else float(context.closes[exit_index])
            )
            exit_reason = "16:00 New York close"
            finished = exit_index >= count - 1
        else:
            exit_index, stopped = exit_match
            exit_price = stop_price if stopped else target_price
            exit_reason = "Stop loss" if stopped else "Take profit"
            finished = False

        gross = (exit_price - entry_price) * side * POINT_VALUE * request.contracts
        pnl = gross - per_trade_cost
        equity += pnl
        peak_equity = max(peak_equity, equity)
        max_drawdown = max(max_drawdown, peak_equity - equity)
        pnl_values.append(pnl)
        if include_details and timestamps is not None:
            entry_time = pd.Timestamp(timestamps.iloc[entry_index])
            exit_time = pd.Timestamp(timestamps.iloc[exit_index])
            setup_time = pd.Timestamp(timestamps.iloc[setup_index])
            trade_id = f"T{len(trades) + 1:05d}"
            trades.append(
                {
                    "id": trade_id,
                    "side": "long" if side == 1 else "short",
                    "entry_time": entry_time.isoformat(),
                    "exit_time": exit_time.isoformat(),
                    "entry_price": round(entry_price, 2),
                    "exit_price": round(exit_price, 2),
                    "stop_price": round(stop_price, 2),
                    "target_price": round(target_price, 2),
                    "stop_mode": "fixed",
                    "stop_distance": round(stop_distance, 2),
                    "setup_time": setup_time.isoformat(),
                    "contracts": request.contracts,
                    "gross_pnl": round(gross, 2),
                    "pnl": round(pnl, 2),
                    "duration_minutes": max(
                        1, int((exit_time - entry_time).total_seconds() // 60)
                    ),
                    "exit_reason": exit_reason,
                }
            )
            equity_points.append(
                {
                    "time": int(exit_time.timestamp()),
                    "value": round(equity, 2),
                    "trade_id": trade_id,
                    "trade_number": len(trades),
                    "net_pnl": round(pnl, 2),
                }
            )
        if finished:
            break
        # Signals on the exit bar are valid new setups after that position has
        # closed; no setup is retained from bars while it was open.
        search_from = exit_index

    return {
        "metrics": _no_wick_metrics(pnl_values, max_drawdown, request.initial_capital),
        "trades": list(reversed(trades)) if include_details else [],
        "equity_curve": equity_points if include_details else [],
    }


def run_no_wick_body_v2(df: pd.DataFrame, request: BacktestRequest) -> dict[str, Any]:
    return simulate_no_wick_body_v2(
        df, request, build_no_wick_v2_context(df), include_details=True
    )


def _range_ifvg_day_setup(
    day_indices: np.ndarray,
    ny_minute: np.ndarray,
    ny_day: np.ndarray,
    times_ns: np.ndarray,
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    breakout_mode: str,
) -> dict[str, Any] | None:
    """Return the day's first valid inversion, or None when the sequence fails."""
    day_minutes = ny_minute[day_indices]
    range_indices = day_indices[
        (day_minutes >= IFVG_RANGE_START_MINUTE)
        & (day_minutes <= IFVG_RANGE_END_MINUTE)
    ]
    expected_minutes = np.arange(
        IFVG_RANGE_START_MINUTE, IFVG_RANGE_END_MINUTE + 1, dtype=np.int16
    )
    if range_indices.size != expected_minutes.size or not np.array_equal(
        ny_minute[range_indices], expected_minutes
    ):
        # Do not silently build a distorted range on an incomplete minute set.
        return None

    range_high = float(np.max(highs[range_indices]))
    range_low = float(np.min(lows[range_indices]))
    range_end_index = int(range_indices[-1])
    noon_indices = day_indices[day_minutes == IFVG_FLATTEN_MINUTE]
    if noon_indices.size:
        flatten_index = int(noon_indices[0])
        flatten_at_open = True
    else:
        before_noon = day_indices[
            (day_minutes < IFVG_FLATTEN_MINUTE) & (day_indices > range_end_index)
        ]
        if not before_noon.size:
            return None
        flatten_index = int(before_noon[-1])
        flatten_at_open = False
    signal_indices = day_indices[
        (day_indices > range_end_index)
        & (day_indices < flatten_index)
        & (day_minutes < IFVG_FLATTEN_MINUTE)
    ]
    if not signal_indices.size:
        return None

    breakout_side = 0  # 1 = range high; -1 = range low
    breakout_index = -1
    recent_extreme_index = -1
    gaps: list[FairValueGap] = []
    one_minute_ns = 60 * 1_000_000_000

    for index_value in signal_indices:
        index = int(index_value)
        if breakout_side == 0:
            if breakout_mode == "close":
                high_broken = closes[index] > range_high
                low_broken = closes[index] < range_low
            else:
                high_broken = highs[index] > range_high
                low_broken = lows[index] < range_low
            if high_broken and low_broken:
                # OHLC data cannot tell which side broke first inside this bar.
                return None
            if not high_broken and not low_broken:
                continue
            breakout_side = 1 if high_broken else -1
            breakout_index = index
            recent_extreme_index = index
            if (breakout_side == 1 and lows[index] < range_low) or (
                breakout_side == -1 and highs[index] > range_high
            ):
                return None
        else:
            # "Unswept" is a liquidity condition, so any wick through the
            # opposite boundary invalidates the target regardless of how the
            # initial-breakout parameter is configured.
            if breakout_side == 1 and lows[index] < range_low:
                return None
            if breakout_side == -1 and highs[index] > range_high:
                return None
            if breakout_side == 1 and highs[index] > highs[recent_extreme_index]:
                recent_extreme_index = index
            elif breakout_side == -1 and lows[index] < lows[recent_extreme_index]:
                recent_extreme_index = index

        first_index = index - 2
        candles_are_consecutive = (
            first_index >= 0
            and ny_day[first_index] == ny_day[index]
            and times_ns[index] - times_ns[index - 1] == one_minute_ns
            and times_ns[index - 1] - times_ns[first_index] == one_minute_ns
        )
        if candles_are_consecutive:
            if breakout_side == 1 and highs[first_index] < lows[index]:
                gaps.append(
                    FairValueGap(
                        first_index=first_index,
                        created_index=index,
                        low=float(highs[first_index]),
                        high=float(lows[index]),
                        inversion_level=float(highs[first_index]),
                    )
                )
            elif breakout_side == -1 and lows[first_index] > highs[index]:
                gaps.append(
                    FairValueGap(
                        first_index=first_index,
                        created_index=index,
                        low=float(highs[index]),
                        high=float(lows[first_index]),
                        inversion_level=float(lows[first_index]),
                    )
                )

        inverted_gap = next(
            (
                gap
                for gap in gaps
                if index > gap.created_index
                and (
                    (breakout_side == 1 and closes[index] < gap.inversion_level)
                    or (breakout_side == -1 and closes[index] > gap.inversion_level)
                )
            ),
            None,
        )
        if inverted_gap is None:
            continue

        entry_price = float(closes[index])
        stop_price = float(
            highs[recent_extreme_index]
            if breakout_side == 1
            else lows[recent_extreme_index]
        )
        target_price = range_low if breakout_side == 1 else range_high
        side = -1 if breakout_side == 1 else 1
        if (side == -1 and not (target_price < entry_price < stop_price)) or (
            side == 1 and not (stop_price < entry_price < target_price)
        ):
            return None
        return {
            "side": side,
            "entry_index": index,
            "entry_price": entry_price,
            "stop_price": stop_price,
            "target_price": target_price,
            "stop_anchor_index": recent_extreme_index,
            "breakout_side": breakout_side,
            "breakout_index": breakout_index,
            "range_start_index": int(range_indices[0]),
            "range_end_index": range_end_index,
            "range_low": range_low,
            "range_high": range_high,
            "gap": inverted_gap,
            "flatten_index": flatten_index,
            "flatten_at_open": flatten_at_open,
        }
    return None


def _find_range_ifvg_exit(
    highs: np.ndarray,
    lows: np.ndarray,
    entry_index: int,
    side: int,
    stop_price: float,
    target_price: float,
    flatten_index: int,
    flatten_price: float,
) -> tuple[int, float, str]:
    for index in range(entry_index + 1, flatten_index):
        if side == 1:
            stopped = lows[index] <= stop_price
            targeted = highs[index] >= target_price
        else:
            stopped = highs[index] >= stop_price
            targeted = lows[index] <= target_price
        # Conservative ordering when both levels occur in one one-minute bar.
        if stopped:
            return index, stop_price, "Stop loss"
        if targeted:
            return index, target_price, "Take profit"
    return flatten_index, flatten_price, "12:00 New York close"


def run_range_ifvg(df: pd.DataFrame, request: BacktestRequest) -> dict[str, Any]:
    if df.empty:
        return empty_result(request.initial_capital)

    timestamps = pd.to_datetime(df["ts_event"], utc=True)
    ny_time = timestamps.dt.tz_convert("America/New_York")
    ny_minute = (ny_time.dt.hour * 60 + ny_time.dt.minute).to_numpy(
        dtype=np.int16, copy=False
    )
    ny_day = (
        ny_time.dt.year * 10_000 + ny_time.dt.month * 100 + ny_time.dt.day
    ).to_numpy(dtype=np.int32, copy=False)
    # Parquet commonly loads timestamps at microsecond resolution while test
    # frames often use nanoseconds. Normalize before checking one-minute gaps.
    times_ns = np.asarray(timestamps.array.as_unit("ns").astype("int64"))
    opens = df["open"].to_numpy(dtype=float, copy=False)
    highs = df["high"].to_numpy(dtype=float, copy=False)
    lows = df["low"].to_numpy(dtype=float, copy=False)
    closes = df["close"].to_numpy(dtype=float, copy=False)

    day_starts = np.concatenate(([0], np.flatnonzero(ny_day[1:] != ny_day[:-1]) + 1))
    day_ends = np.concatenate((day_starts[1:], [len(df)]))
    setups: list[dict[str, Any]] = []
    for day_start, day_end in zip(day_starts, day_ends, strict=True):
        setup = _range_ifvg_day_setup(
            np.arange(day_start, day_end, dtype=np.int64),
            ny_minute,
            ny_day,
            times_ns,
            highs,
            lows,
            closes,
            request.breakout_mode,
        )
        if setup is not None:
            setups.append(setup)

    equity = float(request.initial_capital)
    per_trade_cost = request.contracts * (
        2 * request.commission_per_side
        + 2 * request.slippage_ticks_per_side * TICK_VALUE
    )
    trades: list[dict[str, Any]] = []
    equity_points: list[dict[str, Any]] = []
    available_from = 0

    for setup in setups:
        entry_index = int(setup["entry_index"])
        if entry_index < available_from:
            continue
        side = int(setup["side"])
        stop_price = float(setup["stop_price"])
        target_price = float(setup["target_price"])
        flatten_index = int(setup["flatten_index"])
        flatten_price = float(
            opens[flatten_index]
            if setup["flatten_at_open"]
            else closes[flatten_index]
        )
        exit_index, exit_price, exit_reason = _find_range_ifvg_exit(
            highs,
            lows,
            entry_index,
            side,
            stop_price,
            target_price,
            flatten_index,
            flatten_price,
        )

        entry_price = float(setup["entry_price"])
        gross = (exit_price - entry_price) * side * POINT_VALUE * request.contracts
        pnl = gross - per_trade_cost
        equity += pnl
        entry_time = pd.Timestamp(timestamps.iloc[entry_index])
        exit_time = pd.Timestamp(timestamps.iloc[exit_index])
        gap: FairValueGap = setup["gap"]
        stop_anchor_index = int(setup["stop_anchor_index"])
        trade_id = f"T{len(trades) + 1:05d}"
        trades.append(
            {
                "id": trade_id,
                "side": "long" if side == 1 else "short",
                "entry_time": entry_time.isoformat(),
                "exit_time": exit_time.isoformat(),
                "entry_price": round(entry_price, 2),
                "exit_price": round(exit_price, 2),
                "stop_price": round(stop_price, 2),
                "target_price": round(target_price, 2),
                "stop_mode": "recent-extreme",
                "stop_distance": round(abs(entry_price - stop_price), 2),
                "stop_anchor_time": pd.Timestamp(
                    timestamps.iloc[stop_anchor_index]
                ).isoformat(),
                "stop_anchor_price": round(stop_price, 2),
                "setup_time": pd.Timestamp(
                    timestamps.iloc[gap.created_index]
                ).isoformat(),
                "breakout_time": pd.Timestamp(
                    timestamps.iloc[int(setup["breakout_index"])]
                ).isoformat(),
                "breakout_side": "high" if setup["breakout_side"] == 1 else "low",
                "range_start_time": pd.Timestamp(
                    timestamps.iloc[int(setup["range_start_index"])]
                ).isoformat(),
                "range_end_time": pd.Timestamp(
                    timestamps.iloc[int(setup["range_end_index"])]
                ).isoformat(),
                "range_low": round(float(setup["range_low"]), 2),
                "range_high": round(float(setup["range_high"]), 2),
                "fvg_start_time": pd.Timestamp(
                    timestamps.iloc[gap.first_index]
                ).isoformat(),
                "fvg_created_time": pd.Timestamp(
                    timestamps.iloc[gap.created_index]
                ).isoformat(),
                "fvg_low": round(gap.low, 2),
                "fvg_high": round(gap.high, 2),
                "inversion_level": round(gap.inversion_level, 2),
                "breakout_mode": request.breakout_mode,
                "contracts": request.contracts,
                "gross_pnl": round(gross, 2),
                "pnl": round(pnl, 2),
                "duration_minutes": max(
                    1, int((exit_time - entry_time).total_seconds() // 60)
                ),
                "exit_reason": exit_reason,
            }
        )
        equity_points.append(
            {
                "time": int(exit_time.timestamp()),
                "value": round(equity, 2),
                "trade_id": trade_id,
                "trade_number": len(trades),
                "net_pnl": round(pnl, 2),
            }
        )
        available_from = exit_index

    return summarize(trades, equity_points, request.initial_capital)


def optimize_range_ifvg(
    df: pd.DataFrame,
    request: OptimizationRequest,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    variations: list[dict[str, Any]] = []
    for mode in ("wick", "close"):
        if should_cancel and should_cancel():
            raise OptimizationCancelled
        variation_request = request.model_copy(update={"breakout_mode": mode})
        result = run_range_ifvg(df, variation_request)
        metrics = result["metrics"]
        metrics["drawdown_net_ratio"] = (
            round(metrics["max_drawdown"] / metrics["net_pnl"] * 100, 2)
            if metrics["net_pnl"] > 0
            else None
        )
        variations.append(
            {
                "id": f"IFVG-{mode.upper()}",
                "parameters": {"breakout_mode": mode},
                "metrics": metrics,
            }
        )

    ranked = sorted(
        variations, key=lambda item: _metric_number(item, "net_pnl"), reverse=True
    )
    parameter_rows = [
        {
            "value": item["parameters"]["breakout_mode"],
            "label": "Wick" if item["parameters"]["breakout_mode"] == "wick" else "Body close",
            "tests": 1,
            "total_net_pnl": item["metrics"]["net_pnl"],
            "average_net_pnl": item["metrics"]["net_pnl"],
            "average_win_rate": item["metrics"]["win_rate"],
            "total_trades": item["metrics"]["total_trades"],
        }
        for item in variations
    ]
    return {
        "strategy_id": "range-ifvg",
        "tested": len(variations),
        "returned": len(ranked),
        "search_space": len(variations),
        "variations": ranked,
        "worst_variations": list(reversed(ranked)),
        "parameter_analysis": {"breakout_mode": parameter_rows},
    }


def _sample_optimization_parameters(
    limit: int,
) -> list[dict[str, float | int | str]]:
    default_execution = ("swing", 15.0, 2.0, 0, 15, 0.625)
    execution_space = list(
        product(
            OPTIMIZER_STOP_CONFIGS,
            OPTIMIZER_REWARDS,
            OPTIMIZER_TIME_WINDOWS,
            OPTIMIZER_RANGE_FRACTIONS,
        )
    )
    execution_space = [
        (
            stop_config[0],
            stop_config[1],
            reward,
            window[0],
            window[1],
            range_fraction,
        )
        for stop_config, reward, window, range_fraction in execution_space
    ]
    rng = np.random.default_rng(20260829)
    shuffled_execution = [
        item for item in execution_space if item != default_execution
    ]
    rng.shuffle(shuffled_execution)
    execution_cycle = [default_execution, *shuffled_execution]

    selected_trends = list(product(OPTIMIZER_LOOKBACKS, OPTIMIZER_THRESHOLDS))

    variations: list[dict[str, float | int | str]] = []
    per_trend = int(np.ceil(limit / len(selected_trends)))
    for trend_index, (lookback, threshold) in enumerate(selected_trends):
        execution_offset = trend_index * per_trend
        for offset in range(per_trend):
            (
                stop_mode,
                stop_points,
                reward_risk,
                start_hour,
                end_hour,
                range_fraction,
            ) = (
                execution_cycle[
                    (execution_offset + offset) % len(execution_cycle)
                ]
            )
            variations.append(
                {
                    "trend_lookback": int(lookback),
                    "trend_threshold": round(float(threshold), 2),
                    "stop_mode": str(stop_mode),
                    "stop_points": float(stop_points),
                    "reward_risk": float(reward_risk),
                    "range_fraction": float(range_fraction),
                    "trade_start_hour": int(start_hour),
                    "trade_end_hour": int(end_hour),
                }
            )
    default_parameters: dict[str, float | int | str] = {
        "trend_lookback": 12,
        "trend_threshold": 0.75,
        "range_fraction": 0.625,
        "stop_mode": "swing",
        "stop_points": 15.0,
        "reward_risk": 2.0,
        "trade_start_hour": 0,
        "trade_end_hour": 15,
    }
    if variations and default_parameters not in variations:
        variations[-1] = default_parameters
    return sorted(
        variations[:limit],
        key=lambda item: (
            int(item["trend_lookback"]), float(item["trend_threshold"])
        ),
    )


def _parameter_analysis(variations: list[dict[str, Any]]) -> dict[str, Any]:
    parameter_keys = [
        "trend_lookback",
        "trend_threshold",
        "range_fraction",
        "stop_loss",
        "reward_risk",
        "trade_window",
    ]
    buckets: dict[str, dict[Any, list[dict[str, Any]]]] = {
        key: {} for key in parameter_keys
    }
    for variation in variations:
        params = variation["parameters"]
        values = {
            "trend_lookback": params["trend_lookback"],
            "trend_threshold": params["trend_threshold"],
            "range_fraction": params["range_fraction"],
            "stop_loss": (
                "swing"
                if params["stop_mode"] == "swing"
                else params["stop_points"]
            ),
            "reward_risk": params["reward_risk"],
            "trade_window": (
                params["trade_start_hour"], params["trade_end_hour"]
            ),
        }
        for key, value in values.items():
            buckets[key].setdefault(value, []).append(variation)

    analysis: dict[str, Any] = {}
    for key, groups in buckets.items():
        rows: list[dict[str, Any]] = []
        for value, members in groups.items():
            net_values = [item["metrics"]["net_pnl"] for item in members]
            win_values = [item["metrics"]["win_rate"] for item in members]
            trade_values = [item["metrics"]["total_trades"] for item in members]
            if key == "trade_window":
                start_hour, end_hour = value
                label = f"{start_hour:02d}–{end_hour:02d} NY"
                serialized_value: str | float | int = f"{start_hour}-{end_hour}"
            elif key == "trend_threshold":
                label = f"{round(float(value) * 100)}%"
                serialized_value = float(value)
            elif key == "range_fraction":
                label = f"{float(value) * 100:g}%"
                serialized_value = float(value)
            elif key == "stop_loss":
                if value == "swing":
                    label = "Swing"
                    serialized_value = "swing"
                else:
                    label = f"{int(value)} pt"
                    serialized_value = float(value)
            elif key == "reward_risk":
                label = f"1:{float(value):g}"
                serialized_value = float(value)
            elif key == "trend_lookback":
                label = str(int(value))
                serialized_value = int(value)
            else:
                label = str(value).replace("counter", "counter-trend").title()
                serialized_value = str(value)
            rows.append(
                {
                    "value": serialized_value,
                    "label": label,
                    "tests": len(members),
                    "total_net_pnl": round(float(sum(net_values)), 2),
                    "average_net_pnl": round(float(np.mean(net_values)), 2),
                    "average_win_rate": round(float(np.mean(win_values)), 2),
                    "total_trades": int(sum(trade_values)),
                }
            )
        if key == "trade_window":
            rows.sort(key=lambda row: int(str(row["value"]).split("-")[0]))
        elif key == "stop_loss":
            rows.sort(
                key=lambda row: (
                    0 if row["value"] == "swing" else 1,
                    0 if row["value"] == "swing" else float(row["value"]),
                )
            )
        else:
            rows.sort(key=lambda row: float(row["value"]))
        analysis[key] = rows
    return analysis


def _metric_number(variation: dict[str, Any], key: str) -> float:
    value = variation["metrics"].get(key)
    if value is None:
        return float("-inf")
    return float(value)


def _shortlist_variations(
    variations: list[dict[str, Any]], count: int = 20
) -> list[dict[str, Any]]:
    ranking_specs = [
        ("net_pnl", True),
        ("win_rate", True),
        ("total_trades", True),
        ("max_drawdown", False),
        ("drawdown_net_ratio", False),
        ("average_trade", True),
    ]
    selected_ids: set[str] = set()
    for key, descending in ranking_specs:
        eligible = [
            item
            for item in variations
            if item["metrics"]["total_trades"] > 0
            and item["metrics"].get(key) is not None
        ]
        ranked = sorted(
            eligible,
            key=lambda item: _metric_number(item, key),
            reverse=descending,
        )
        selected_ids.update(item["id"] for item in ranked[:count])
    swing_ranked = sorted(
        (
            item
            for item in variations
            if item["parameters"].get("stop_mode") == "swing"
            and item["metrics"]["total_trades"] > 0
        ),
        key=lambda item: _metric_number(item, "net_pnl"),
        reverse=True,
    )
    selected_ids.update(item["id"] for item in swing_ranked[:count])
    return [item for item in variations if item["id"] in selected_ids]


def optimize_no_wick_body(
    df: pd.DataFrame,
    request: OptimizationRequest,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    parameters = _sample_optimization_parameters(request.max_variations)
    variations: list[dict[str, Any]] = []
    active_trend_key: tuple[int, float] | None = None
    active_context: NoWickContext | None = None
    for index, params in enumerate(parameters, start=1):
        if should_cancel and should_cancel():
            raise OptimizationCancelled
        trend_key = (
            int(params["trend_lookback"]),
            float(params["trend_threshold"]),
        )
        if trend_key != active_trend_key:
            active_context = build_no_wick_context(df, *trend_key)
            active_trend_key = trend_key
        assert active_context is not None
        variation_request = request.model_copy(update=params)
        result = simulate_no_wick_body(
            df, variation_request, active_context, include_details=False
        )
        metrics = result["metrics"]
        metrics["drawdown_net_ratio"] = (
            round(metrics["max_drawdown"] / metrics["net_pnl"] * 100, 2)
            if metrics["net_pnl"] > 0
            else None
        )
        variations.append(
            {
                "id": f"NWB-{index:04d}",
                "parameters": params,
                "metrics": metrics,
            }
        )
    shortlisted = _shortlist_variations(variations)
    worst = sorted(variations, key=lambda item: _metric_number(item, "net_pnl"))[:5]
    return {
        "strategy_id": "no-wick-body",
        "tested": len(variations),
        "returned": len(shortlisted),
        "search_space": (
            len(OPTIMIZER_LOOKBACKS)
            * len(OPTIMIZER_THRESHOLDS)
            * len(OPTIMIZER_STOP_CONFIGS)
            * len(OPTIMIZER_REWARDS)
            * len(OPTIMIZER_TIME_WINDOWS)
            * len(OPTIMIZER_RANGE_FRACTIONS)
        ),
        "variations": shortlisted,
        "worst_variations": worst,
        "parameter_analysis": _parameter_analysis(variations),
    }


def _sample_no_wick_v2_parameters(
    limit: int,
) -> list[dict[str, float | int | str]]:
    all_parameters = [
        {
            "v2_stop_points": stop_points,
            "v2_reward_risk": reward_risk,
            "v2_entry_delay_bars": entry_delay,
            "v2_order_expiry_mode": expiry_mode,
            "v2_order_expiry_bars": expiry_bars,
        }
        for stop_points, reward_risk, entry_delay, (expiry_mode, expiry_bars) in product(
            V2_STOP_POINTS,
            V2_REWARDS,
            V2_ENTRY_DELAYS,
            V2_EXPIRY_CONFIGS,
        )
    ]
    default = {
        "v2_stop_points": 2.0,
        "v2_reward_risk": 3.0,
        "v2_entry_delay_bars": 1,
        "v2_order_expiry_mode": "next_signal",
        "v2_order_expiry_bars": 5,
    }
    if limit >= len(all_parameters):
        return all_parameters
    # Keep the existing optimizer's responsive 500-run behaviour, while first
    # guaranteeing at least one test for every value in every V2 dimension.
    rng = np.random.default_rng(20260829)
    coverage = [
        default,
        *(
            {
                **default,
                "v2_stop_points": stop_points,
            }
            for stop_points in V2_STOP_POINTS
        ),
        *(
            {
                **default,
                "v2_reward_risk": reward_risk,
            }
            for reward_risk in V2_REWARDS
        ),
        *(
            {
                **default,
                "v2_entry_delay_bars": entry_delay,
            }
            for entry_delay in V2_ENTRY_DELAYS
        ),
        *(
            {
                **default,
                "v2_order_expiry_mode": expiry_mode,
                "v2_order_expiry_bars": expiry_bars,
            }
            for expiry_mode, expiry_bars in V2_EXPIRY_CONFIGS
        ),
    ]
    selected: list[dict[str, float | int | str]] = []
    for params in coverage:
        if params not in selected:
            selected.append(params)
    available = [params for params in all_parameters if params not in selected]
    needed = max(0, limit - len(selected))
    selected.extend(available[int(index)] for index in rng.choice(
        len(available), size=needed, replace=False
    ))
    return selected[:limit]


def _parameter_analysis_v2(variations: list[dict[str, Any]]) -> dict[str, Any]:
    parameter_keys = ["stop_loss", "reward_risk", "entry_delay_bars", "order_expiry"]
    buckets: dict[str, dict[Any, list[dict[str, Any]]]] = {
        key: {} for key in parameter_keys
    }
    for variation in variations:
        params = variation["parameters"]
        expiry = (
            "Next wickless signal"
            if params["v2_order_expiry_mode"] == "next_signal"
            else int(params["v2_order_expiry_bars"])
        )
        values = {
            "stop_loss": params["v2_stop_points"],
            "reward_risk": params["v2_reward_risk"],
            "entry_delay_bars": params["v2_entry_delay_bars"],
            "order_expiry": expiry,
        }
        for key, value in values.items():
            buckets[key].setdefault(value, []).append(variation)

    analysis: dict[str, Any] = {}
    for key, groups in buckets.items():
        rows: list[dict[str, Any]] = []
        for value, members in groups.items():
            net_values = [item["metrics"]["net_pnl"] for item in members]
            win_values = [item["metrics"]["win_rate"] for item in members]
            trade_values = [item["metrics"]["total_trades"] for item in members]
            if key == "stop_loss":
                label, serialized_value = f"{float(value):g} pt", float(value)
            elif key == "reward_risk":
                label, serialized_value = f"1:{float(value):g}", float(value)
            elif key == "entry_delay_bars":
                label = "Next bar" if int(value) == 0 else f"{int(value)} bar"
                serialized_value = int(value)
            elif value == "Next wickless signal":
                label, serialized_value = str(value), "next_signal"
            else:
                label, serialized_value = f"{int(value)} bars", int(value)
            rows.append(
                {
                    "value": serialized_value,
                    "label": label,
                    "tests": len(members),
                    "total_net_pnl": round(float(sum(net_values)), 2),
                    "average_net_pnl": round(float(np.mean(net_values)), 2),
                    "average_win_rate": round(float(np.mean(win_values)), 2),
                    "total_trades": int(sum(trade_values)),
                }
            )
        if key == "order_expiry":
            rows.sort(key=lambda row: (1, 0) if row["value"] == "next_signal" else (0, int(row["value"])))
        else:
            rows.sort(key=lambda row: float(row["value"]))
        analysis[key] = rows
    return analysis


def optimize_no_wick_body_v2(
    df: pd.DataFrame,
    request: OptimizationRequest,
    should_cancel: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    parameters = _sample_no_wick_v2_parameters(request.max_variations)
    context = build_no_wick_v2_context(df)
    variations: list[dict[str, Any]] = []
    for index, params in enumerate(parameters, start=1):
        if should_cancel and should_cancel():
            raise OptimizationCancelled
        result = simulate_no_wick_body_v2(
            df, request.model_copy(update=params), context, include_details=False
        )
        metrics = result["metrics"]
        metrics["drawdown_net_ratio"] = (
            round(metrics["max_drawdown"] / metrics["net_pnl"] * 100, 2)
            if metrics["net_pnl"] > 0
            else None
        )
        variations.append(
            {"id": f"NWV2-{index:04d}", "parameters": params, "metrics": metrics}
        )
    shortlisted = _shortlist_variations(variations)
    worst = sorted(variations, key=lambda item: _metric_number(item, "net_pnl"))[:5]
    return {
        "strategy_id": "no-wick-body-v2",
        "tested": len(variations),
        "returned": len(shortlisted),
        "search_space": (
            len(V2_STOP_POINTS)
            * len(V2_REWARDS)
            * len(V2_ENTRY_DELAYS)
            * len(V2_EXPIRY_CONFIGS)
        ),
        "variations": shortlisted,
        "worst_variations": worst,
        "parameter_analysis": _parameter_analysis_v2(variations),
    }


def summarize(
    trades: list[dict[str, Any]], equity_points: list[dict[str, Any]], initial_capital: float
) -> dict[str, Any]:
    if not trades:
        return empty_result(initial_capital)
    pnls = np.array([trade["pnl"] for trade in trades], dtype=float)
    wins = pnls[pnls > 0]
    losses = pnls[pnls < 0]
    equity_values = np.array([initial_capital] + [point["value"] for point in equity_points])
    peaks = np.maximum.accumulate(equity_values)
    drawdowns = equity_values - peaks
    max_dd = abs(float(drawdowns.min()))
    profit_factor = float(wins.sum() / abs(losses.sum())) if losses.size else float("inf")

    return {
        "metrics": {
            "net_pnl": round(float(pnls.sum()), 2),
            "total_trades": int(len(trades)),
            "win_rate": round(float((pnls > 0).mean() * 100), 2),
            "max_drawdown": round(max_dd, 2),
            "profit_factor": round(profit_factor, 2) if np.isfinite(profit_factor) else None,
            "average_trade": round(float(pnls.mean()), 2),
            "ending_equity": round(float(initial_capital + pnls.sum()), 2),
        },
        "trades": list(reversed(trades)),
        "equity_curve": equity_points,
    }


def empty_result(initial_capital: float) -> dict[str, Any]:
    return {
        "metrics": {
            "net_pnl": 0.0,
            "total_trades": 0,
            "win_rate": 0.0,
            "max_drawdown": 0.0,
            "profit_factor": None,
            "average_trade": 0.0,
            "ending_equity": initial_capital,
        },
        "trades": [],
        "equity_curve": [],
    }
