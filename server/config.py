from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env")


@dataclass(frozen=True)
class Settings:
    root_dir: Path = ROOT_DIR
    data_dir: Path = Path(os.getenv("DATA_DIR", ROOT_DIR / "data")).resolve()
    databento_api_key: str = os.getenv("DATABENTO_API_KEY", "").strip()
    max_download_cost_usd: float = float(os.getenv("MAX_DOWNLOAD_COST_USD", "125"))
    dataset: str = "GLBX.MDP3"
    symbol: str = "NQ.v.0"
    schema: str = "ohlcv-1m"
    stype_in: str = "continuous"

    @property
    def candle_file(self) -> Path:
        return self.data_dir / "nq_continuous_1m.parquet"

    def timeframe_file(self, timeframe: str) -> Path:
        return self.data_dir / f"nq_continuous_{timeframe}.parquet"

    @property
    def coverage_file(self) -> Path:
        return self.data_dir / "metadata" / "coverage.json"

    @property
    def conditions_file(self) -> Path:
        return self.data_dir / "metadata" / "dataset_conditions.json"


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.coverage_file.parent.mkdir(parents=True, exist_ok=True)
