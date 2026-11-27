"""統一 OHLCV 格式與本地 CSV 快取。標準欄位：date, open, high, low, close, volume（還原權息）。"""
from __future__ import annotations

import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional, Tuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = ROOT / "data" / "cache"
STD_COLS = ["date", "open", "high", "low", "close", "volume"]


def _market_tz(name: str, fallback_hours: int) -> Any:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=fallback_hours))


def market_post_close_cutoff(market: str, now_utc: Optional[datetime] = None) -> Tuple[date, float]:
    """回傳市場最近一個應已收盤的交易日（週一至五）與該日收盤緩衝後的 UTC 時間戳。"""
    m = market.upper()
    if m == "TW":
        tz = _market_tz("Asia/Taipei", 8)
        cutoff_hm = (13, 45)
    else:
        tz = _market_tz("America/New_York", -5)
        cutoff_hm = (16, 15)

    cur_utc = now_utc if now_utc is not None else datetime.now(timezone.utc)
    if cur_utc.tzinfo is None:
        cur_utc = cur_utc.replace(tzinfo=timezone.utc)
    local_now = cur_utc.astimezone(tz)

    cand = local_now.date()
    if cand.weekday() >= 5:
        cand -= timedelta(days=cand.weekday() - 4)
    elif (local_now.hour, local_now.minute) < cutoff_hm:
        cand -= timedelta(days=1)
        while cand.weekday() >= 5:
            cand -= timedelta(days=1)

    cutoff_local = datetime(cand.year, cand.month, cand.day, cutoff_hm[0], cutoff_hm[1], tzinfo=tz)
    return cand, cutoff_local.astimezone(timezone.utc).timestamp()


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


def read_cache(
    path: Path,
    max_age_hours: float = 12,
    min_latest_date: Optional[date] = None,
    min_mtime_ts: Optional[float] = None,
) -> Optional[pd.DataFrame]:
    if not path.exists():
        return None
    mtime = path.stat().st_mtime
    if (time.time() - mtime) >= max_age_hours * 3600:
        return None
    df = standardize(pd.read_csv(path))
    if df.empty:
        return None
    if min_latest_date is not None:
        cached_last = df["date"].max().date()
        if cached_last < min_latest_date and (min_mtime_ts is None or mtime < min_mtime_ts):
            return None
    return df


def write_cache(path: Path, df: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)
