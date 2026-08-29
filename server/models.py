from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class DownloadRequest(BaseModel):
    start: datetime
    end: datetime
    max_cost_usd: float | None = Field(default=None, gt=0)


class BacktestRequest(BaseModel):
    strategy_id: str = "no-wick-body"
    timeframe: Literal["1m", "5m", "15m", "1h"] = "1m"
    start: datetime
    end: datetime
    contracts: int = Field(default=1, ge=1, le=100)
    commission_per_side: float = Field(default=2.25, ge=0)
    slippage_ticks_per_side: float = Field(default=1.0, ge=0)
    initial_capital: float = Field(default=50_000, gt=0)
    trend_lookback: int = Field(default=12, ge=12, le=30)
    trend_threshold: float = Field(default=0.75, ge=0.6, le=0.8)
    range_fraction: float = Field(default=0.625, ge=0.25, le=0.75)
    stop_mode: Literal["fixed", "swing"] = "swing"
    stop_points: float = Field(default=15.0, ge=15.0, le=50.0)
    reward_risk: float = Field(default=2.0, ge=2.0, le=5.0)
    trade_start_hour: int = Field(default=0, ge=0, le=23)
    trade_end_hour: int = Field(default=15, ge=1, le=24)
    breakout_mode: Literal["wick", "close"] = "wick"
    v2_stop_points: float = Field(default=2.0, ge=1.0, le=5.0)
    v2_reward_risk: float = Field(default=3.0, ge=3.0, le=10.0)
    v2_entry_delay_bars: int = Field(default=1, ge=0, le=5)
    v2_order_expiry_mode: Literal["bars", "next_signal"] = "next_signal"
    v2_order_expiry_bars: int = Field(default=5, ge=5, le=20)


class OptimizationRequest(BacktestRequest):
    strategy_id: Literal["no-wick-body", "no-wick-body-v2", "range-ifvg"] = "no-wick-body"
    max_variations: int = Field(default=500, ge=20, le=500)


class OptimizationCancelRequest(BaseModel):
    strategy_id: Literal["no-wick-body", "no-wick-body-v2", "range-ifvg"]
