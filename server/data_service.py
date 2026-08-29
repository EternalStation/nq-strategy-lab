from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import databento as db
import duckdb
import pandas as pd

from .config import settings
from .demo_data import generate_demo_candles


TIMEFRAME_RULES = {
    "1m": "1min",
    "5m": "5min",
    "15m": "15min",
    "1h": "1h",
}

TIMEFRAME_SQL_INTERVALS = {
    "5m": "5 minutes",
    "15m": "15 minutes",
    "1h": "1 hour",
}


def _historical_client() -> db.Historical:
    if not settings.databento_api_key:
        raise RuntimeError("DATABENTO_API_KEY is not configured")
    return db.Historical(settings.databento_api_key)


def get_dataset_range() -> dict[str, Any]:
    client = _historical_client()
    return client.metadata.get_dataset_range(dataset=settings.dataset)


def save_dataset_conditions(start: str, end: str) -> dict[str, Any]:
    client = _historical_client()
    rows = client.metadata.get_dataset_condition(
        dataset=settings.dataset,
        start_date=start[:10],
        end_date=end[:10],
    )
    summary = {
        "available": sum(row["condition"] == "available" for row in rows),
        "degraded": sum(row["condition"] == "degraded" for row in rows),
        "missing": sum(row["condition"] == "missing" for row in rows),
        "pending": sum(row["condition"] == "pending" for row in rows),
    }
    payload = {"summary": summary, "days": rows}
    settings.conditions_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def quote_download(start: datetime | str, end: datetime | str) -> dict[str, Any]:
    client = _historical_client()
    cost = client.metadata.get_cost(
        dataset=settings.dataset,
        symbols=[settings.symbol],
        schema=settings.schema,
        stype_in=settings.stype_in,
        start=start,
        end=end,
    )
    size = client.metadata.get_billable_size(
        dataset=settings.dataset,
        symbols=[settings.symbol],
        schema=settings.schema,
        stype_in=settings.stype_in,
        start=start,
        end=end,
    )
    return {
        "dataset": settings.dataset,
        "symbol": settings.symbol,
        "schema": settings.schema,
        "start": str(start),
        "end": str(end),
        "cost_usd": round(float(cost), 6),
        "billable_bytes": int(size),
    }


def download_history(
    start: datetime | str,
    end: datetime | str,
    max_cost_usd: float | None = None,
) -> dict[str, Any]:
    limit = settings.max_download_cost_usd if max_cost_usd is None else min(
        max_cost_usd, settings.max_download_cost_usd
    )
    quote = quote_download(start, end)
    if quote["cost_usd"] > limit:
        raise ValueError(
            f"Quoted cost ${quote['cost_usd']:.4f} exceeds the ${limit:.2f} safety limit"
        )

    client = _historical_client()
    store = client.timeseries.get_range(
        dataset=settings.dataset,
        symbols=[settings.symbol],
        schema=settings.schema,
        stype_in=settings.stype_in,
        start=start,
        end=end,
    )
    temp_file = settings.candle_file.with_suffix(".parquet.part")
    store.to_parquet(temp_file, price_type="float", pretty_ts=True, map_symbols=True, mode="w")
    temp_file.replace(settings.candle_file)

    coverage = inspect_coverage()
    coverage.update({"quote": quote, "downloaded_at": datetime.now(timezone.utc).isoformat()})
    settings.coverage_file.write_text(json.dumps(coverage, indent=2), encoding="utf-8")
    return coverage


def build_derived_timeframes() -> dict[str, Any]:
    if not settings.candle_file.exists():
        raise FileNotFoundError("One-minute source data has not been downloaded")
    source = str(settings.candle_file).replace("'", "''")
    results: dict[str, Any] = {}
    con = duckdb.connect()
    try:
        for timeframe, interval in TIMEFRAME_SQL_INTERVALS.items():
            output_file = settings.timeframe_file(timeframe)
            temp_file = output_file.with_suffix(".parquet.part")
            target = str(temp_file).replace("'", "''")
            con.execute(
                f"""
                COPY (
                    SELECT
                        time_bucket(INTERVAL '{interval}', ts_event) AS ts_event,
                        arg_min(open, ts_event) AS open,
                        max(high) AS high,
                        min(low) AS low,
                        arg_max(close, ts_event) AS close,
                        sum(volume)::BIGINT AS volume,
                        arg_max(instrument_id, ts_event) AS instrument_id,
                        arg_max(COALESCE(symbol, 'NQ.v.0'), ts_event) AS symbol
                    FROM read_parquet('{source}')
                    GROUP BY 1
                    ORDER BY 1
                ) TO '{target}' (FORMAT PARQUET, COMPRESSION ZSTD)
                """
            )
            temp_file.replace(output_file)
            row = con.execute(
                "SELECT count(*), min(ts_event), max(ts_event) FROM read_parquet(?)",
                [str(output_file)],
            ).fetchone()
            results[timeframe] = {
                "bars": int(row[0]),
                "start": row[1].isoformat(),
                "end": row[2].isoformat(),
                "file_size_bytes": output_file.stat().st_size,
            }
    finally:
        con.close()
    return results


def inspect_coverage() -> dict[str, Any]:
    if not settings.candle_file.exists():
        return {
            "source": "demo",
            "status": "ready",
            "symbol": "NQ-DEMO",
            "timeframe": "1m",
            "start": None,
            "end": None,
            "bars": 4_000,
            "file_size_bytes": 0,
            "quality": None,
        }
    con = duckdb.connect()
    row = con.execute(
        """
        SELECT min(ts_event), max(ts_event), count(*)
        FROM read_parquet(?)
        """,
        [str(settings.candle_file)],
    ).fetchone()
    con.close()
    quality = None
    if settings.conditions_file.exists():
        quality = json.loads(settings.conditions_file.read_text(encoding="utf-8")).get("summary")
    return {
        "source": "databento",
        "status": "ready",
        "symbol": settings.symbol,
        "timeframe": "1m",
        "start": row[0].isoformat() if row and row[0] else None,
        "end": row[1].isoformat() if row and row[1] else None,
        "bars": int(row[2]) if row else 0,
        "file_size_bytes": settings.candle_file.stat().st_size,
        "quality": quality,
    }


def _load_raw(
    start: datetime | None,
    end: datetime | None,
    source_file: Path | None = None,
    row_limit: int | None = None,
    newest_first: bool = False,
) -> pd.DataFrame:
    selected_file = source_file or settings.candle_file
    if not selected_file.exists():
        data = generate_demo_candles()
        if start is not None:
            start_ts = pd.Timestamp(start)
            if start_ts.tzinfo is None:
                start_ts = start_ts.tz_localize("UTC")
            data = data[data["ts_event"] >= start_ts]
        if end is not None:
            end_ts = pd.Timestamp(end)
            if end_ts.tzinfo is None:
                end_ts = end_ts.tz_localize("UTC")
            data = data[data["ts_event"] < end_ts]
        if row_limit is not None:
            data = data.tail(row_limit) if newest_first else data.head(row_limit)
        return data.sort_values("ts_event").reset_index(drop=True)

    clauses: list[str] = []
    params: list[Any] = [str(selected_file)]
    if start is not None:
        clauses.append("ts_event >= ?")
        params.append(start)
    if end is not None:
        clauses.append("ts_event < ?")
        params.append(end)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    order = "DESC" if newest_first else "ASC"
    limit_clause = "LIMIT ?" if row_limit is not None else ""
    if row_limit is not None:
        params.append(row_limit)
    con = duckdb.connect()
    df = con.execute(
        f"""
        SELECT ts_event, open, high, low, close, volume, instrument_id,
               COALESCE(symbol, 'NQ.v.0') AS symbol
        FROM read_parquet(?)
        {where}
        ORDER BY ts_event {order}
        {limit_clause}
        """,
        params,
    ).fetch_df()
    con.close()
    df["ts_event"] = pd.to_datetime(df["ts_event"], utc=True)
    return df.sort_values("ts_event").reset_index(drop=True)


def load_candles(
    timeframe: str,
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = 5_000,
) -> pd.DataFrame:
    if timeframe not in TIMEFRAME_RULES:
        raise ValueError(f"Unsupported timeframe: {timeframe}")

    # Keep chart requests bounded. Backtests call load_backtest_frame directly.
    derived_file = settings.timeframe_file(timeframe)
    use_derived = timeframe != "1m" and derived_file.exists()
    source_file = derived_file if use_derived else None
    raw_limit = limit if timeframe == "1m" or use_derived else limit * {
        "5m": 5,
        "15m": 15,
        "1h": 60,
    }[timeframe]
    df = _load_raw(start, end, source_file, row_limit=raw_limit, newest_first=True)
    if df.empty:
        return df
    if timeframe != "1m" and not use_derived:
        df = resample_candles(df, timeframe)
    return df.tail(limit).reset_index(drop=True)


def load_candles_around(
    timeframe: str,
    focus_start: datetime,
    focus_end: datetime,
    limit: int = 3_000,
    future_bars: int = 500,
) -> pd.DataFrame:
    """Return a bounded chart window that always includes the focused interval."""
    if timeframe not in TIMEFRAME_RULES:
        raise ValueError(f"Unsupported timeframe: {timeframe}")
    if focus_end < focus_start:
        focus_start, focus_end = focus_end, focus_start

    bar_minutes = {"1m": 1, "5m": 5, "15m": 15, "1h": 60}[timeframe]
    bar_delta = timedelta(minutes=bar_minutes)
    derived_file = settings.timeframe_file(timeframe)
    use_derived = timeframe != "1m" and derived_file.exists()

    if timeframe != "1m" and not use_derived:
        window_start = focus_start - bar_delta * max(0, limit - future_bars)
        window_end = focus_end + bar_delta * (future_bars + 1)
        raw = _load_raw(window_start, window_end)
        frame = resample_candles(raw, timeframe) if not raw.empty else raw
        core_mask = (frame["ts_event"] >= pd.Timestamp(focus_start)) & (
            frame["ts_event"] <= pd.Timestamp(focus_end)
        )
        core = frame[core_mask]
        future = frame[frame["ts_event"] > pd.Timestamp(focus_end)].head(future_bars)
        remaining = max(0, limit - len(core) - len(future))
        before = frame[frame["ts_event"] < pd.Timestamp(focus_start)].tail(remaining)
        return pd.concat([before, core, future]).drop_duplicates("ts_event").reset_index(drop=True)

    source_file = derived_file if use_derived else None
    focus_after = focus_end + bar_delta
    core = _load_raw(focus_start, focus_after, source_file)
    future = _load_raw(
        focus_after,
        None,
        source_file,
        row_limit=future_bars,
    )
    remaining = max(0, limit - len(core) - len(future))
    before = _load_raw(
        None,
        focus_start,
        source_file,
        row_limit=remaining,
        newest_first=True,
    )
    return (
        pd.concat([before, core, future])
        .drop_duplicates("ts_event")
        .sort_values("ts_event")
        .reset_index(drop=True)
    )


def load_backtest_frame(timeframe: str, start: datetime, end: datetime) -> pd.DataFrame:
    derived_file = settings.timeframe_file(timeframe)
    use_derived = timeframe != "1m" and derived_file.exists()
    df = _load_raw(start, end, derived_file if use_derived else None)
    if timeframe != "1m" and not use_derived and not df.empty:
        df = resample_candles(df, timeframe)
    return df.reset_index(drop=True)


def resample_candles(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    rule = TIMEFRAME_RULES[timeframe]
    indexed = df.set_index("ts_event")
    result = indexed.resample(rule, label="left", closed="left", origin="start_day").agg(
        {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
            "instrument_id": "last",
            "symbol": "last",
        }
    )
    result = result.dropna(subset=["open", "high", "low", "close"]).reset_index()
    return result


def frame_to_records(df: pd.DataFrame) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for row in df.itertuples(index=False):
        records.append(
            {
                "time": int(pd.Timestamp(row.ts_event).timestamp()),
                "open": float(row.open),
                "high": float(row.high),
                "low": float(row.low),
                "close": float(row.close),
                "instrument_id": int(getattr(row, "instrument_id", 0)),
                "symbol": str(getattr(row, "symbol", settings.symbol)),
            }
        )
    return records
