"""統一 OHLCV 格式與本地 CSV 快取。標準欄位：date, open, high, low, close, volume（還原權息）。"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / "data" / "cache"
STD_COLS = ["date", "open", "high", "low", "close", "volume"]


def standardize(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(c).strip().lower() for c in df.columns]
    missing = set(STD_COLS) - set(df.columns)
    if missing:
        raise ValueError(f"缺少欄位: {missing}")
    df = df[STD_COLS]
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None).dt.normalize()
    return df.dropna().sort_values("date").drop_duplicates("date").reset_index(drop=True)


def cache_path(source: str, market: str, symbol: str) -> Path:
    safe = symbol.replace("^", "").replace(":", "_").replace("/", "_")
    return CACHE_DIR / f"{source}_{market}_{safe}.csv"


def read_cache(path: Path, max_age_hours: float = 12) -> Optional[pd.DataFrame]:
    if path.exists() and (time.time() - path.stat().st_mtime) < max_age_hours * 3600:
        return standardize(pd.read_csv(path))
    return None


def write_cache(path: Path, df: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)
