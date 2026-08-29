from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd


def generate_demo_candles(count: int = 4_000) -> pd.DataFrame:
    """Deterministic candles used only until a Databento file is present."""
    rng = np.random.default_rng(4219)
    end = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    index = pd.date_range(end=end, periods=count, freq="1min", tz="UTC")
    walk = 20_100 + np.cumsum(rng.normal(0.03, 4.1, count))
    opens = np.r_[walk[0], walk[:-1]]
    closes = walk
    spread = rng.uniform(0.5, 7.0, count)
    highs = np.maximum(opens, closes) + spread
    lows = np.minimum(opens, closes) - spread * rng.uniform(0.45, 1.0, count)
    volumes = rng.integers(12, 440, count)
    return pd.DataFrame(
        {
            "ts_event": index,
            "open": np.round(opens * 4) / 4,
            "high": np.round(highs * 4) / 4,
            "low": np.round(lows * 4) / 4,
            "close": np.round(closes * 4) / 4,
            "volume": volumes,
            "instrument_id": 0,
            "symbol": "NQ-DEMO",
        }
    )

