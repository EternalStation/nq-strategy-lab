from __future__ import annotations

import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import pandas as pd

from fastapi import HTTPException

from server.backtest import OptimizationCancelled, optimize_no_wick_body_v2, run_strategy
from server.models import BacktestRequest, OptimizationCancelRequest, OptimizationRequest
from server.main import (
    _claim_optimizer,
    _release_optimizer,
    cancel_optimizer,
    optimize_backtest,
)


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


def request(**overrides: object) -> BacktestRequest:
    values: dict[str, object] = {
        "strategy_id": "no-wick-body-v2",
        "timeframe": "1m",
        "start": datetime(2026, 1, 5, tzinfo=timezone.utc),
        "end": datetime(2026, 1, 7, tzinfo=timezone.utc),
        "v2_stop_points": 1,
        "v2_reward_risk": 3,
        "v2_entry_delay_bars": 0,
        "v2_order_expiry_mode": "next_signal",
    }
    values.update(overrides)
    return BacktestRequest(**values)


def close_bar(day: str = "2026-01-06", open_: float = 100.0) -> dict:
    time = pd.Timestamp(f"{day} 16:00", tz="America/New_York")
    return bar(time, open_, open_ + 0.5, open_ - 0.5, open_)


class NoWickV2Tests(unittest.TestCase):
    def test_bearish_lower_wickless_candle_creates_long_after_delay(self) -> None:
        times = pd.date_range("2026-01-05 20:00", periods=4, freq="1min", tz="America/New_York")
        rows = [
            bar(times[0], 101.0, 102.0, 100.0, 100.0),  # bearish, no lower wick => long
            bar(times[1], 101.0, 102.0, 99.0, 100.0),
            bar(times[2], 100.5, 100.75, 100.0, 100.25),
            bar(times[3], 101.0, 103.0, 100.5, 102.5),
            close_bar(),
        ]
        result = run_strategy(pd.DataFrame(rows), request(v2_entry_delay_bars=1))

        self.assertEqual(result["metrics"]["total_trades"], 1)
        trade = result["trades"][0]
        self.assertEqual(trade["side"], "long")
        self.assertIn("01:02:00+00:00", trade["entry_time"])
        self.assertEqual(trade["entry_price"], 100.0)
        self.assertEqual(trade["exit_reason"], "Take profit")

    def test_bullish_upper_wickless_candle_creates_short(self) -> None:
        times = pd.date_range("2026-01-05 20:00", periods=4, freq="1min", tz="America/New_York")
        rows = [
            bar(times[0], 100.0, 102.0, 99.0, 102.0),  # bullish, no upper wick => short
            bar(times[1], 101.75, 102.0, 101.5, 101.75),
            bar(times[2], 101.0, 101.5, 99.0, 99.5),
            bar(times[3], 100.0, 100.5, 99.5, 100.0),
            close_bar(),
        ]
        result = run_strategy(pd.DataFrame(rows), request())

        self.assertEqual(result["metrics"]["total_trades"], 1)
        trade = result["trades"][0]
        self.assertEqual(trade["side"], "short")
        self.assertEqual(trade["entry_price"], 102.0)
        self.assertEqual(trade["exit_reason"], "Take profit")

    def test_new_wickless_signal_replaces_an_unfilled_limit(self) -> None:
        times = pd.date_range("2026-01-05 20:00", periods=4, freq="1min", tz="America/New_York")
        rows = [
            bar(times[0], 101.0, 102.0, 100.0, 100.0),
            bar(times[1], 102.0, 103.0, 101.0, 101.0),
            bar(times[2], 101.5, 101.75, 101.0, 101.25),
            bar(times[3], 102.0, 104.0, 101.5, 103.0),
            close_bar(),
        ]
        result = run_strategy(pd.DataFrame(rows), request(v2_order_expiry_mode="bars", v2_order_expiry_bars=20))

        self.assertEqual(result["metrics"]["total_trades"], 1)
        self.assertEqual(result["trades"][0]["entry_price"], 101.0)
        self.assertIn("01:02:00+00:00", result["trades"][0]["entry_time"])

    def test_open_position_flattens_at_four_pm_new_york(self) -> None:
        times = pd.date_range("2026-01-05 15:57", periods=4, freq="1min", tz="America/New_York")
        rows = [
            bar(times[0], 101.0, 102.0, 100.0, 100.0),
            bar(times[1], 100.5, 100.75, 100.0, 100.25),
            bar(times[2], 100.25, 100.5, 100.0, 100.25),
            close_bar("2026-01-05", open_=101.5),
        ]
        result = run_strategy(pd.DataFrame(rows), request(v2_reward_risk=10))

        self.assertEqual(result["metrics"]["total_trades"], 1)
        trade = result["trades"][0]
        self.assertEqual(trade["exit_reason"], "16:00 New York close")
        self.assertEqual(trade["exit_price"], 101.5)

    def test_optimizer_exposes_v2_parameter_space(self) -> None:
        time = pd.Timestamp("2026-01-05 20:00", tz="America/New_York")
        frame = pd.DataFrame([bar(time, 101.0, 102.0, 100.0, 100.0), close_bar()])
        result = optimize_no_wick_body_v2(
            frame,
            OptimizationRequest(
                strategy_id="no-wick-body-v2",
                timeframe="1m",
                start=datetime(2026, 1, 5, tzinfo=timezone.utc),
                end=datetime(2026, 1, 7, tzinfo=timezone.utc),
                max_variations=20,
            ),
        )
        self.assertEqual(result["search_space"], 7650)
        self.assertEqual(result["tested"], 20)
        self.assertIn("entry_delay_bars", result["parameter_analysis"])
        self.assertIn("order_expiry", result["parameter_analysis"])

    def test_api_optimizer_dispatches_only_v2(self) -> None:
        time = pd.Timestamp("2026-01-05 20:00", tz="America/New_York")
        frame = pd.DataFrame([bar(time, 101.0, 102.0, 100.0, 100.0), close_bar()])
        optimization_request = OptimizationRequest(
            strategy_id="no-wick-body-v2",
            timeframe="1m",
            start=datetime(2026, 1, 5, tzinfo=timezone.utc),
            end=datetime(2026, 1, 7, tzinfo=timezone.utc),
            max_variations=20,
        )
        with patch("server.main.load_backtest_frame", return_value=frame):
            result = optimize_backtest(optimization_request)

        self.assertEqual(result["strategy_id"], "no-wick-body-v2")
        self.assertEqual(result["tested"], 20)

    def test_only_one_optimizer_can_be_claimed_and_it_can_be_stopped(self) -> None:
        cancel_event = _claim_optimizer("no-wick-body-v2")
        try:
            with self.assertRaises(HTTPException) as blocked:
                _claim_optimizer("no-wick-body")
            self.assertEqual(blocked.exception.status_code, 409)

            result = cancel_optimizer(
                OptimizationCancelRequest(strategy_id="no-wick-body-v2")
            )
            self.assertEqual(result["status"], "stopping")
            self.assertTrue(cancel_event.is_set())
        finally:
            _release_optimizer("no-wick-body-v2", cancel_event)

    def test_v2_optimizer_honors_cancellation(self) -> None:
        time = pd.Timestamp("2026-01-05 20:00", tz="America/New_York")
        frame = pd.DataFrame([bar(time, 101.0, 102.0, 100.0, 100.0), close_bar()])
        with self.assertRaises(OptimizationCancelled):
            optimize_no_wick_body_v2(
                frame,
                OptimizationRequest(
                    strategy_id="no-wick-body-v2",
                    timeframe="1m",
                    start=datetime(2026, 1, 5, tzinfo=timezone.utc),
                    end=datetime(2026, 1, 7, tzinfo=timezone.utc),
                    max_variations=20,
                ),
                should_cancel=lambda: True,
            )


if __name__ == "__main__":
    unittest.main()
