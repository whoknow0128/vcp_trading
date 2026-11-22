"""將 mcp-tv-get-ohlcv (format=columns) 的 JSON 輸出轉存為 data/cache/tv_<market>_<symbol>.csv

用法: python -m adapters.import_mcp_output --file output.txt --market TW --symbol 2330
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from .base import cache_path, standardize, write_cache


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--file", required=True)
    p.add_argument("--market", required=True, choices=["TW", "US"])
    p.add_argument("--symbol", required=True)
    a = p.parse_args()

    raw = json.loads(Path(a.file).read_text(encoding="utf-8").split("\n\nThe following")[0])
    b = raw["bars"]
    df = pd.DataFrame({"date": b["t"], "open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"], "volume": b.get("v")})
    df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0)  # 指數無成交量 → 0
    tz = "Asia/Taipei" if a.market == "TW" else "America/New_York"
    df["date"] = pd.to_datetime(df["date"], unit="s", utc=True).dt.tz_convert(tz)
    df = standardize(df)
    path = cache_path("tv", a.market, a.symbol)
    write_cache(path, df)
    print(f"{path}  {len(df)} bars  {df.date.iloc[0].date()} ~ {df.date.iloc[-1].date()}  (adjust note: {raw.get('notice', '')[-60:]})")


if __name__ == "__main__":
    main()
