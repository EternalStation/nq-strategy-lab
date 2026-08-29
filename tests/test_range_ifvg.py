from __future__ import annotations

import unittest
from datetime import datetime, timezone

import pandas as pd

from server.backtest import optimize_range_ifvg, run_strategy
from server.models import BacktestRequest, OptimizationRequest


def bar(time: pd.Timestamp, open_: float, high: float, low: float, close: float) -> dict:
    return {
        "ts_event": time.tz_convert("UTC"),
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
        "volume": 1,
        "instrument_id": 1,
        "symbol": "NQ",
    }


def range_bars(day: str = "2026-01-05") -> list[dict]:
    times = pd.date_range(
        f"{day} 08:12", f"{day} 09:12", freq="1min", tz="America/New_York"
    )
    return [bar(time, 105.0, 110.0, 100.0, 105.0) for time in times]


def noon_bar(day: str = "2026-01-05", open_: float = 105.0) -> dict:
    time = pd.Timestamp(f"{day} 12:00", tz="America/New_York")
    return bar(time, open_, open_ + 0.5, open_ - 0.5, open_)


def request(mode: str = "wick") -> BacktestRequest:
    return BacktestRequest(
        strategy_id="range-ifvg",
        timeframe="1m",
        start=datetime(2026, 1, 5, tzinfo=timezone.utc),
        end=datetime(2026, 1, 7, tzinfo=timezone.utc),
        breakout_mode=mode,
    )


class RangeIfvgTests(unittest.TestCase):
    def test_wick_break_bullish_gap_inverts_into_short(self) -> None:
        rows = range_bars()
        times = pd.date_range(
            "2026-01-05 09:13", periods=6, freq="1min", tz="America/New_York"
        )
        rows.extend(
            [
                bar(times[0], 109.0, 111.0, 108.5, 109.0),
                bar(times[1], 109.0, 109.25, 108.75, 109.1),
                bar(times[2], 109.4, 109.75, 109.25, 109.5),
                bar(times[3], 109.7, 110.0, 109.5, 109.75),
                bar(times[4], 109.7, 110.0, 109.0, 109.0),
                bar(times[5], 109.0, 109.5, 99.5, 100.0),
            ]
        )
        rows.append(noon_bar())
        frame = pd.DataFrame(rows)
        # Match the microsecond timestamp resolution loaded from Parquet.
        frame["ts_event"] = frame["ts_event"].astype("datetime64[us, UTC]")

        wick_result = run_strategy(frame, request("wick"))
        close_result = run_strategy(frame, request("close"))

        self.assertEqual(wick_result["metrics"]["total_trades"], 1)
        self.assertEqual(close_result["metrics"]["total_trades"], 0)
        trade = wick_result["trades"][0]
        self.assertEqual(trade["side"], "short")
        self.assertEqual(trade["entry_price"], 109.0)
        self.assertEqual(trade["stop_price"], 111.0)
        self.assertEqual(trade["target_price"], 100.0)
        self.assertEqual(trade["fvg_low"], 109.25)
        self.assertEqual(trade["fvg_high"], 109.5)
        self.assertEqual(trade["exit_reason"], "Take profit")

    def test_close_break_can_create_short_setup(self) -> None:
        rows = range_bars()
        times = pd.date_range(
            "2026-01-05 09:13", periods=6, freq="1min", tz="America/New_York"
        )
        rows.extend(
            [
                bar(times[0], 109.5, 110.5, 109.0, 110.25),
                bar(times[1], 110.2, 110.5, 110.0, 110.3),
                bar(times[2], 110.5, 110.8, 110.4, 110.6),
                bar(times[3], 110.9, 111.25, 110.75, 111.0),
                bar(times[4], 111.0, 111.5, 110.0, 110.25),
                bar(times[5], 110.0, 110.5, 99.5, 100.0),
            ]
        )
        rows.append(noon_bar())

        result = run_strategy(pd.DataFrame(rows), request("close"))

        self.assertEqual(result["metrics"]["total_trades"], 1)
        trade = result["trades"][0]
        self.assertEqual(trade["breakout_mode"], "close")
        self.assertEqual(trade["side"], "short")
        self.assertEqual(trade["stop_price"], 111.5)

    def test_low_break_bearish_gap_inverts_into_long(self) -> None:
        rows = range_bars()
        times = pd.date_range(
            "2026-01-05 09:13", periods=6, freq="1min", tz="America/New_York"
        )
        rows.extend(
            [
                bar(times[0], 101.0, 101.5, 99.0, 101.0),
                bar(times[1], 101.2, 101.5, 101.0, 101.2),
                bar(times[2], 101.0, 101.25, 100.75, 101.0),
                bar(times[3], 100.5, 100.75, 100.25, 100.5),
                bar(times[4], 100.5, 101.5, 100.0, 101.25),
                bar(times[5], 101.5, 110.5, 101.0, 110.0),
            ]
        )
        rows.append(noon_bar())

        result = run_strategy(pd.DataFrame(rows), request("wick"))

        self.assertEqual(result["metrics"]["total_trades"], 1)
        trade = result["trades"][0]
        self.assertEqual(trade["side"], "long")
        self.assertEqual(trade["entry_price"], 101.25)
        self.assertEqual(trade["stop_price"], 99.0)
        self.assertEqual(trade["target_price"], 110.0)
        self.assertEqual(trade["fvg_low"], 100.75)
        self.assertEqual(trade["fvg_high"], 101.0)

    def test_incomplete_range_is_skipped(self) -> None:
        rows = range_bars()
        del rows[20]
        result = run_strategy(pd.DataFrame(rows), request("wick"))
        self.assertEqual(result["metrics"]["total_trades"], 0)

    def test_both_sides_broken_on_same_wick_bar_is_skipped(self) -> None:
        rows = range_bars()
        time = pd.Timestamp("2026-01-05 09:13", tz="America/New_York")
        rows.append(bar(time, 105.0, 111.0, 99.0, 105.0))
        rows.append(noon_bar())
        result = run_strategy(pd.DataFrame(rows), request("wick"))
        self.assertEqual(result["metrics"]["total_trades"], 0)

    def test_open_trade_is_flattened_at_noon_open(self) -> None:
        rows = range_bars()
        times = pd.date_range(
            "2026-01-05 09:13", periods=5, freq="1min", tz="America/New_York"
        )
        rows.extend(
            [
                bar(times[0], 109.0, 111.0, 108.5, 109.0),
                bar(times[1], 109.0, 109.25, 108.75, 109.1),
                bar(times[2], 109.4, 109.75, 109.25, 109.5),
                bar(times[3], 109.7, 110.0, 109.5, 109.75),
                bar(times[4], 109.7, 110.0, 109.0, 109.0),
            ]
        )
        rows.append(noon_bar(open_=108.0))

        result = run_strategy(pd.DataFrame(rows), request("wick"))

        self.assertEqual(result["metrics"]["total_trades"], 1)
        trade = result["trades"][0]
        self.assertEqual(trade["exit_reason"], "12:00 New York close")
        self.assertEqual(trade["exit_price"], 108.0)
        self.assertIn("17:00:00+00:00", trade["exit_time"])

    def test_no_entry_is_allowed_at_or_after_noon(self) -> None:
        rows = range_bars()
        rows.append(noon_bar())
        times = pd.date_range(
            "2026-01-05 12:01", periods=5, freq="1min", tz="America/New_York"
        )
        rows.extend(
            [
                bar(times[0], 109.0, 111.0, 108.5, 109.0),
                bar(times[1], 109.0, 109.25, 108.75, 109.1),
                bar(times[2], 109.4, 109.75, 109.25, 109.5),
                bar(times[3], 109.7, 110.0, 109.5, 109.75),
                bar(times[4], 109.7, 110.0, 109.0, 109.0),
            ]
        )

        result = run_strategy(pd.DataFrame(rows), request("wick"))

        self.assertEqual(result["metrics"]["total_trades"], 0)

    def test_optimizer_compares_both_breakout_modes(self) -> None:
        frame = pd.DataFrame(range_bars())
        optimization_request = OptimizationRequest(
            strategy_id="range-ifvg",
            timeframe="1m",
            start=datetime(2026, 1, 5, tzinfo=timezone.utc),
            end=datetime(2026, 1, 7, tzinfo=timezone.utc),
        )

        result = optimize_range_ifvg(frame, optimization_request)

        self.assertEqual(result["tested"], 2)
        self.assertEqual(
            {row["parameters"]["breakout_mode"] for row in result["variations"]},
            {"wick", "close"},
        )
        self.assertEqual(len(result["parameter_analysis"]["breakout_mode"]), 2)


if __name__ == "__main__":
    unittest.main()
