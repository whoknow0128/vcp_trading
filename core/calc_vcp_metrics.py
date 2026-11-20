"""
core/calc_vcp_metrics.py
Mark Minervini SEPA / VCP 核心量化指標運算引擎（台股 / 美股共用）
依賴套件：pandas, numpy（無須編譯 TA-Lib）
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from typing import Any, Dict, Optional

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class MarketConfig:
    market: str
    ma_short: int
    ma_mid: int
    ma_long: int
    benchmark_symbol: str
    ma_mode_label: str


MARKET_CONFIGS = {
    "US": MarketConfig(
        market="US",
        ma_short=50,
        ma_mid=150,
        ma_long=200,
        benchmark_symbol="QQQ",
        ma_mode_label="50_150_200",
    ),
    "TW": MarketConfig(
        market="TW",
        ma_short=60,
        ma_mid=120,
        ma_long=240,
        benchmark_symbol="^TWII",
        ma_mode_label="60_120_240",
    ),
}


def _normalize_ohlcv(df: pd.DataFrame) -> pd.DataFrame:
    """標準化欄位名稱並依日期遞增排序。"""
    df = df.copy()
    df.columns = [c.strip().lower() for c in df.columns]
    required = {"date", "open", "high", "low", "close", "volume"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"OHLCV DataFrame 缺少必要欄位: {missing}")

    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").drop_duplicates(subset=["date"]).reset_index(drop=True)
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df.dropna(subset=["open", "high", "low", "close", "volume"])


def _calc_atr(df: pd.DataFrame, period: int) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - prev_close).abs(),
            (df["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.rolling(window=period, min_periods=period).mean()


def _detect_pocket_pivot(df: pd.DataFrame, lookback_days: int = 5) -> bool:
    """
    口袋支點（Pocket Pivot）：
    近 lookback_days 內，是否出現任一上漲日，其成交量 > 該日前 10 個交易日內所有下跌日的最大成交量。
    """
    if len(df) < 15:
        return False

    close_diff = df["close"].diff()
    down_vol = np.where(close_diff < 0, df["volume"], 0.0)
    down_vol_series = pd.Series(down_vol, index=df.index)
    max_prev10_down_vol = down_vol_series.shift(1).rolling(10, min_periods=1).max()

    is_up_day = close_diff > 0
    is_pocket_pivot = is_up_day & (df["volume"] > max_prev10_down_vol) & (max_prev10_down_vol > 0)
    return bool(is_pocket_pivot.iloc[-lookback_days:].any())


def _count_distribution_days(df: pd.DataFrame, window: int = 10) -> int:
    """
    出貨日（Distribution Day）統計：
    近 window 日內，收跌（跌幅 >= 0.2%）且成交量高於前一日並高於 50 日均量的天數。
    """
    if len(df) < 55:
        return 0

    pct_chg = df["close"].pct_change()
    vol_ma50 = df["volume"].rolling(50).mean()
    is_dist = (pct_chg <= -0.002) & (df["volume"] > df["volume"].shift(1)) & (df["volume"] > vol_ma50)
    return int(is_dist.iloc[-window:].sum())


def calculate_vcp_metrics(
    symbol: str,
    stock_df: pd.DataFrame,
    benchmark_df: pd.DataFrame,
    market: str = "US",
    catalysts: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    計算 SEPA / VCP 四關卡核心指標並回傳標準化 JSON 字典。
    """
    market = market.upper()
    if market not in MARKET_CONFIGS:
        raise ValueError(f"不支援的市場類型: {market}，請使用 'US' 或 'TW'")
    cfg = MARKET_CONFIGS[market]

    df = _normalize_ohlcv(stock_df)
    bm = _normalize_ohlcv(benchmark_df)

    min_bars = cfg.ma_long + 25
    if len(df) < min_bars:
        return {
            "error": f"歷史 K 棒不足（目前 {len(df)} 根，至少需要 {min_bars} 根以計算 {cfg.ma_long}MA 趨勢）",
            "symbol": symbol,
            "market": market,
        }

    # --- 1. 計算個股均線與位階 ---
    df["ma10"] = df["close"].rolling(10).mean()
    df["ma20"] = df["close"].rolling(20).mean()
    df["ma_short"] = df["close"].rolling(cfg.ma_short).mean()
    df["ma_mid"] = df["close"].rolling(cfg.ma_mid).mean()
    df["ma_long"] = df["close"].rolling(cfg.ma_long).mean()

    latest = df.iloc[-1]
    close_price = float(latest["close"])

    high_52w = float(df["high"].iloc[-252:].max())
    low_52w = float(df["low"].iloc[-252:].min())
    pct_from_52w_high = (close_price / high_52w - 1.0) * 100.0
    pct_from_52w_low = (close_price / low_52w - 1.0) * 100.0

    # 200MA / 240MA 近 1 個月（20 個交易日）是否呈現上升
    ma_long_rising_1m = bool(df["ma_long"].iloc[-1] > df["ma_long"].iloc[-21])

    stage2_pass = bool(
        close_price > float(latest["ma_short"]) > float(latest["ma_mid"]) > float(latest["ma_long"])
        and ma_long_rising_1m
        and pct_from_52w_low >= 25.0
        and pct_from_52w_high >= -25.0
    )

    # --- 2. 計算大盤濾網與相對強度 (RS Line) ---
    bm["bm_ma50"] = bm["close"].rolling(50).mean()
    bm["bm_ma200"] = bm["close"].rolling(200).mean()
    bm_latest = bm.iloc[-1]
    bm_above_50 = bool(bm_latest["close"] > bm_latest["bm_ma50"])
    bm_above_200 = bool(bm_latest["close"] > bm_latest["bm_ma200"])
    bm_trend = "UPTREND" if (bm_above_50 and bm_above_200) else ("MIXED" if bm_above_200 else "DOWNTREND")

    merged = pd.merge(
        df[["date", "close"]],
        bm[["date", "close"]].rename(columns={"close": "bm_close"}),
        on="date",
        how="inner",
    )
    if len(merged) >= 60:
        merged["rs_line"] = merged["close"] / merged["bm_close"]
        merged["rs_ma50"] = merged["rs_line"].rolling(50).mean()
        rs_current = float(merged["rs_line"].iloc[-1])
        rs_52w_max = float(merged["rs_line"].iloc[-252:].max())
        rs_line_52w_high = bool(rs_current >= rs_52w_max * 0.995)  # 容許 0.5% 誤差視為創高/平高
        rs_above_ma50 = bool(rs_current > float(merged["rs_ma50"].iloc[-1]))
    else:
        rs_line_52w_high = False
        rs_above_ma50 = False

    # --- 3. 布林通道與壓縮量化 (BBW) ---
    bb_mid = df["ma20"]
    bb_std = df["close"].rolling(20).std(ddof=0)
    bb_upper = bb_mid + 2.0 * bb_std
    bb_lower = bb_mid - 2.0 * bb_std
    bbw_series = ((bb_upper - bb_lower) / bb_mid) * 100.0

    bbw_current = float(bbw_series.iloc[-1])
    bbw_120d = bbw_series.iloc[-120:].dropna()
    bbw_120d_percentile = float((bbw_120d <= bbw_current).mean() * 100.0) if len(bbw_120d) > 0 else 50.0
    price_above_bb_mid = bool(close_price >= float(bb_mid.iloc[-1]))

    # --- 4. 股性 (ADR%)、微觀緊湊度 (ATR 收斂) 與乖離 ---
    adr_20d_pct = float((((df["high"] - df["low"]) / df["low"]).rolling(20).mean().iloc[-1]) * 100.0)
    atr_5 = float(_calc_atr(df, 5).iloc[-1])
    atr_20 = float(_calc_atr(df, 20).iloc[-1])
    atr_5_20_ratio = round(atr_5 / atr_20, 3) if atr_20 > 0 else 1.0

    dist_from_10ma_in_atr = round((close_price - float(latest["ma10"])) / atr_20, 2) if atr_20 > 0 else 0.0

    # --- 5. 量價關係 (VDU, 口袋支點, 出貨日) ---
    vol_ma50 = float(df["volume"].rolling(50).mean().iloc[-1])
    vol_ratio_50d = round(float(latest["volume"]) / vol_ma50, 2) if vol_ma50 > 0 else 1.0
    # 極度量縮 (VDU)：近 3 日均量低於 50 日均量的 70%
    recent_3d_vol_avg = float(df["volume"].iloc[-3:].mean())
    is_vdu_3d = bool(vol_ma50 > 0 and recent_3d_vol_avg < vol_ma50 * 0.70)

    pocket_pivot_in_5d = _detect_pocket_pivot(df, lookback_days=5)
    dist_days_10d = _count_distribution_days(df, window=10)

    # --- 6. 右側緊湊整理帶與初步 Pivot / Stop-Loss 估算 ---
    recent_10d_high = float(df["high"].iloc[-10:].max())
    recent_10d_low = float(df["low"].iloc[-10:].min())
    tightness_10d_pct = round((recent_10d_high - recent_10d_low) / recent_10d_high * 100.0, 2)

    # 樞紐突破價設於近 10 日高點上方約 0.2%
    suggested_pivot = round(recent_10d_high * 1.002, 2)
    # 停損設於近 10 日低點微幅下方，但最大不超過 Pivot 下方 8%
    hard_stop_floor = suggested_pivot * 0.92
    suggested_stop_loss = round(max(recent_10d_low * 0.995, hard_stop_floor), 2)
    stop_loss_pct = round((suggested_stop_loss / suggested_pivot - 1.0) * 100.0, 2)
    stop_loss_in_atr = round((suggested_pivot - suggested_stop_loss) / atr_20, 2) if atr_20 > 0 else 0.0

    # --- 7. 系統初步評級提示 (供 AI Skill 參考與海選排序) ---
    if not stage2_pass or dist_days_10d >= 3 or dist_from_10ma_in_atr > 3.5:
        pre_grade = "C"
    elif (
        bbw_120d_percentile <= 25.0
        and atr_5_20_ratio <= 0.75
        and tightness_10d_pct <= 10.0
        and (is_vdu_3d or pocket_pivot_in_5d)
    ):
        # 若今日已放量突破則為 A 候選，否則為 B 觀察
        is_breakout_today = close_price >= recent_10d_high * 0.995 and vol_ratio_50d >= 1.4
        pre_grade = "A_CANDIDATE" if is_breakout_today else "B_WATCHLIST"
    else:
        pre_grade = "B_OR_C_REVIEW"

    return {
        "meta": {
            "symbol": symbol,
            "market": market,
            "data_date": latest["date"].strftime("%Y-%m-%d"),
            "close_price": round(close_price, 2),
            "benchmark_symbol": cfg.benchmark_symbol,
            "ma_mode": cfg.ma_mode_label,
            "pre_filter_grade": pre_grade,
        },
        "gate1_market": {
            "benchmark_above_50ma": bm_above_50,
            "benchmark_above_200ma": bm_above_200,
            "benchmark_trend": bm_trend,
        },
        "gate2_trend_rs": {
            "stage2_template_pass": stage2_pass,
            "ma_values": {
                "ma20": round(float(latest["ma20"]), 2),
                f"ma{cfg.ma_short}": round(float(latest["ma_short"]), 2),
                f"ma{cfg.ma_mid}": round(float(latest["ma_mid"]), 2),
                f"ma{cfg.ma_long}": round(float(latest["ma_long"]), 2),
            },
            "ma_long_rising_1m": ma_long_rising_1m,
            "pct_from_52w_high": round(pct_from_52w_high, 2),
            "pct_from_52w_low": round(pct_from_52w_low, 2),
            "rs_line_52w_high": rs_line_52w_high,
            "rs_above_ma50": rs_above_ma50,
        },
        "gate3_catalysts": catalysts or {"status": "NOT_PROVIDED_REQUIRE_MANUAL_OR_ADAPTER"},
        "gate4_setup_risk": {
            "bbw_current_pct": round(bbw_current, 2),
            "bbw_120d_percentile": round(bbw_120d_percentile, 2),
            "price_above_bb_mid": price_above_bb_mid,
            "adr_20d_pct": round(adr_20d_pct, 2),
            "atr_5_20_ratio": atr_5_20_ratio,
            "tightness_10d_pct": tightness_10d_pct,
            "vol_ratio_50d": vol_ratio_50d,
            "is_vdu_3d": is_vdu_3d,
            "pocket_pivot_in_5d": pocket_pivot_in_5d,
            "distribution_days_10d": dist_days_10d,
            "dist_from_10ma_in_atr": dist_from_10ma_in_atr,
            "recent_10d_high": round(recent_10d_high, 2),
            "recent_10d_low": round(recent_10d_low, 2),
            "suggested_pivot": suggested_pivot,
            "suggested_stop_loss": suggested_stop_loss,
            "stop_loss_pct": stop_loss_pct,
            "stop_loss_in_atr": stop_loss_in_atr,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="計算 SEPA / VCP 量化指標並輸出 JSON")
    parser.add_argument("--symbol", required=True, help="股票代號，例如 NVDA 或 2330")
    parser.add_argument("--market", default="US", choices=["US", "TW"], help="市場類型 (US / TW)")
    parser.add_argument("--stock-csv", required=True, help="個股還原日線 OHLCV CSV 路徑")
    parser.add_argument("--benchmark-csv", required=True, help="大盤指數日線 OHLCV CSV 路徑")
    args = parser.parse_args()

    stock_df = pd.read_csv(args.stock_csv)
    benchmark_df = pd.read_csv(args.benchmark_csv)

    result = calculate_vcp_metrics(
        symbol=args.symbol,
        stock_df=stock_df,
        benchmark_df=benchmark_df,
        market=args.market,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
