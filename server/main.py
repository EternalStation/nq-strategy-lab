from __future__ import annotations

from datetime import datetime, timedelta, timezone
from threading import Event, Lock
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .backtest import (
    OptimizationCancelled,
    optimize_no_wick_body,
    optimize_no_wick_body_v2,
    optimize_range_ifvg,
    run_strategy,
)
from .config import settings
from .data_service import (
    download_history,
    frame_to_records,
    get_dataset_range,
    inspect_coverage,
    load_backtest_frame,
    load_candles,
    load_candles_around,
    quote_download,
)
from .models import (
    BacktestRequest,
    DownloadRequest,
    OptimizationCancelRequest,
    OptimizationRequest,
)


app = FastAPI(title="NQ Strategy Lab API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_optimizer_state_lock = Lock()
_active_optimizer_strategy: str | None = None
_active_optimizer_cancel: Event | None = None


def _claim_optimizer(strategy_id: str) -> Event:
    global _active_optimizer_strategy, _active_optimizer_cancel
    with _optimizer_state_lock:
        if _active_optimizer_strategy is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"{_active_optimizer_strategy} is already optimizing. "
                    "Stop it before starting another strategy."
                ),
            )
        cancel_event = Event()
        _active_optimizer_strategy = strategy_id
        _active_optimizer_cancel = cancel_event
        return cancel_event


def _release_optimizer(strategy_id: str, cancel_event: Event) -> None:
    global _active_optimizer_strategy, _active_optimizer_cancel
    with _optimizer_state_lock:
        if (
            _active_optimizer_strategy == strategy_id
            and _active_optimizer_cancel is cancel_event
        ):
            _active_optimizer_strategy = None
            _active_optimizer_cancel = None


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "api_key_configured": bool(settings.databento_api_key),
        "data_source": inspect_coverage()["source"],
    }


@app.get("/api/coverage")
def coverage() -> dict[str, Any]:
    return inspect_coverage()


@app.get("/api/data/range")
def data_range() -> dict[str, Any]:
    try:
        return get_dataset_range()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/data/quote")
def data_quote(start: datetime, end: datetime) -> dict[str, Any]:
    try:
        return quote_download(start, end)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/data/download")
def data_download(request: DownloadRequest) -> dict[str, Any]:
    try:
        return download_history(request.start, request.end, request.max_cost_usd)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/candles")
def candles(
    timeframe: str = Query(default="1m", pattern="^(1m|5m|15m|1h)$"),
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = Query(default=3_000, ge=100, le=20_000),
    focus_start: datetime | None = None,
    focus_end: datetime | None = None,
    future_bars: int = Query(default=500, ge=0, le=5_000),
) -> dict[str, Any]:
    try:
        if focus_start is not None or focus_end is not None:
            anchor_start = focus_start or focus_end
            anchor_end = focus_end or focus_start
            assert anchor_start is not None and anchor_end is not None
            frame = load_candles_around(
                timeframe,
                anchor_start,
                anchor_end,
                limit,
                future_bars,
            )
        else:
            frame = load_candles(timeframe, start, end, limit)
        return {"timeframe": timeframe, "candles": frame_to_records(frame)}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/backtests/run")
def run_backtest(request: BacktestRequest) -> dict[str, Any]:
    try:
        frame = load_backtest_frame(request.timeframe, request.start, request.end)
        result = run_strategy(frame, request)
        result["strategy_id"] = request.strategy_id
        result["range"] = {
            "start": request.start.isoformat(),
            "end": request.end.isoformat(),
            "bars": int(len(frame)),
        }
        return result
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/backtests/optimize")
def optimize_backtest(request: OptimizationRequest) -> dict[str, Any]:
    cancel_event = _claim_optimizer(request.strategy_id)
    try:
        frame = load_backtest_frame(request.timeframe, request.start, request.end)
        if cancel_event.is_set():
            raise OptimizationCancelled
        if request.strategy_id == "range-ifvg":
            if request.timeframe != "1m":
                raise ValueError("Range iFVG requires the 1-minute timeframe")
            result = optimize_range_ifvg(frame, request, cancel_event.is_set)
        elif request.strategy_id == "no-wick-body-v2":
            if request.timeframe != "1m":
                raise ValueError("No Wick Body V2 requires the 1-minute timeframe")
            result = optimize_no_wick_body_v2(frame, request, cancel_event.is_set)
        else:
            result = optimize_no_wick_body(frame, request, cancel_event.is_set)
        result["range"] = {
            "start": request.start.isoformat(),
            "end": request.end.isoformat(),
            "bars": int(len(frame)),
        }
        return result
    except OptimizationCancelled as exc:
        raise HTTPException(status_code=409, detail="Optimization stopped") from exc
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        _release_optimizer(request.strategy_id, cancel_event)


@app.post("/api/backtests/optimize/cancel")
def cancel_optimizer(request: OptimizationCancelRequest) -> dict[str, str]:
    with _optimizer_state_lock:
        if _active_optimizer_strategy is None or _active_optimizer_cancel is None:
            return {"status": "idle", "strategy_id": request.strategy_id}
        if _active_optimizer_strategy != request.strategy_id:
            raise HTTPException(
                status_code=409,
                detail=f"{_active_optimizer_strategy} is the active optimizer",
            )
        _active_optimizer_cancel.set()
        return {"status": "stopping", "strategy_id": request.strategy_id}
