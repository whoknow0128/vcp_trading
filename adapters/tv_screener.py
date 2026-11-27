"""台股還原權息日 K 與 TradingView Scanner 批次初篩介面。

職責：
  1. TradingView Scanner 全市場 Stage 2 初篩（US / TW）與單股基本面查詢；
  2. 台股還原權息（含除權＋除息）歷史日 K：優先使用本地快取，其次 Yahoo Finance v8 Chart API
     （`adjclose / close` 還原係數），最後退回 TradingView MCP 匯入快取。
"""
from __future__ import annotations

import json
import ssl
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pandas as pd

from .base import CACHE_DIR, cache_path, market_post_close_cutoff, read_cache, standardize, write_cache

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def _ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx


def _tz(name: str, fallback_hours: int) -> Any:
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=fallback_hours))


def import_mcp_bars(symbol: str, bars: List[Dict], market: str = "TW") -> None:
    """將 mcp-tv-get-ohlcv rows 格式 [{t,o,h,l,c,v}] 轉存為快取 CSV。"""
    df = pd.DataFrame(bars).rename(
        columns={"t": "date", "o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"}
    )
    df["date"] = pd.to_datetime(df["date"], unit="s", utc=True).dt.tz_convert(_tz("Asia/Taipei", 8))
    write_cache(cache_path("tv", market, symbol), standardize(df))


def _fetch_yahoo_v8_adjusted(ticker: str, bars: int = 330) -> pd.DataFrame:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ticker)}?range=2y&interval=1d"
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=15, context=_ssl_context()) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    result = (payload.get("chart") or {}).get("result")
    if not result:
        raise RuntimeError(f"Yahoo v8 無資料: {ticker}")

    res = result[0]
    ts = res.get("timestamp") or []
    indicators = res.get("indicators") or {}
    quote = (indicators.get("quote") or [{}])[0]
    adj_list = ((indicators.get("adjclose") or [{}])[0]).get("adjclose")
    meta_price = (res.get("meta") or {}).get("regularMarketPrice")

    n = len(ts)
    if n == 0:
        raise RuntimeError(f"Yahoo v8 K 棒為空: {ticker}")

    opens = list(quote.get("open") or [None] * n)
    highs = list(quote.get("high") or [None] * n)
    lows = list(quote.get("low") or [None] * n)
    closes = list(quote.get("close") or [None] * n)
    vols = [0.0 if v is None else v for v in (quote.get("volume") or [0.0] * n)]
    adjs = list(adj_list) if adj_list and len(adj_list) == n else [None] * n

    if closes[-1] is None and opens[-1] is not None and meta_price is not None and float(meta_price) > 0:
        mp = float(meta_price)
        closes[-1] = mp
        adjs[-1] = mp
        if highs[-1] is None:
            highs[-1] = max(float(opens[-1]), mp)
        if lows[-1] is None:
            lows[-1] = min(float(opens[-1]), mp)

    df = pd.DataFrame(
        {
            "date": pd.to_datetime(ts, unit="s", utc=True).tz_convert(_tz("Asia/Taipei", 8)),
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": vols,
            "adjclose": adjs,
        }
    )
    for col in ("open", "high", "low", "close", "volume", "adjclose"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=["open", "high", "low", "close"]).copy()
    df = df[df["close"] > 0].copy()
    df["volume"] = df["volume"].fillna(0.0)

    factor = df["adjclose"] / df["close"]
    valid_adj = df["adjclose"].notna() & (df["adjclose"] > 0) & factor.notna() & (factor > 0)
    if valid_adj.any():
        adj_factor = factor.where(valid_adj, 1.0)
        for col in ("open", "high", "low"):
            df[col] = df[col] * adj_factor
        df["close"] = df["adjclose"].where(valid_adj, df["close"])

    return standardize(df[["date", "open", "high", "low", "close", "volume"]]).tail(bars).reset_index(drop=True)


def _tw_ticker_candidates(symbol: str, exchange: Optional[str] = None) -> List[str]:
    if symbol.startswith("^") or "." in symbol:
        return [symbol]
    if (exchange or "").upper() == "TPEX":
        return [f"{symbol}.TWO", f"{symbol}.TW"]
    return [f"{symbol}.TW", f"{symbol}.TWO"]


def fetch_tw_history(
    symbol: str,
    bars: int = 330,
    exchange: Optional[str] = None,
    max_cache_hours: float = 12.0,
) -> pd.DataFrame:
    adj_path = cache_path("yf_adj", "TW", symbol)
    expected_tw_date, cutoff_ts = market_post_close_cutoff("TW")
    fresh = read_cache(
        adj_path,
        max_age_hours=max_cache_hours,
        min_latest_date=expected_tw_date,
        min_mtime_ts=cutoff_ts,
    )
    if fresh is not None and len(fresh) >= 265:
        return fresh.tail(bars).reset_index(drop=True)

    for ticker in _tw_ticker_candidates(symbol, exchange=exchange):
        try:
            df = _fetch_yahoo_v8_adjusted(ticker, bars=bars)
            if len(df) >= 265:
                try:
                    write_cache(adj_path, df)
                except OSError as exc:
                    print(f"[tv_screener] 寫入台股還原快取失敗 ({symbol}): {exc}", file=sys.stderr)
                return df.tail(bars).reset_index(drop=True)
        except Exception:
            continue

    stale = read_cache(adj_path, max_age_hours=10**6)
    if stale is not None and len(stale) >= 265:
        print(f"[tv_screener] Yahoo v8 暫時無法取得 {symbol}，改用既有還原快取", file=sys.stderr)
        return stale.tail(bars).reset_index(drop=True)

    tv_cached = read_cache(cache_path("tv", "TW", symbol), max_age_hours=10**6)
    if tv_cached is not None and len(tv_cached) >= 265:
        print(
            f"[tv_screener] 警告：{symbol} 使用 TradingView MCP 舊快取（僅還原拆股，未含除息還原）",
            file=sys.stderr,
        )
        return tv_cached.tail(bars).reset_index(drop=True)

    raise RuntimeError(f"取不到台股還原權息歷史資料: {symbol}")


def _post_tv_scan(scanner_market: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    url = f"https://scanner.tradingview.com/{scanner_market}/scan"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": _UA},
    )
    with urllib.request.urlopen(req, timeout=15, context=_ssl_context()) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _parse_tv_rows(rows: List[Dict[str, Any]], cols: List[str], is_us: bool) -> List[Dict[str, Any]]:
    ny_tz = _tz("America/New_York", -5)
    parsed: List[Dict[str, Any]] = []
    for row in rows:
        vals = row.get("d") or []
        m = dict(zip(cols, vals))
        sym = str(m.get("name") or "").strip()
        if not sym:
            continue

        earnings_ts = m.get("earnings_release_next_date") if is_us else None
        next_earnings_date: Optional[str] = None
        if earnings_ts is not None:
            try:
                next_earnings_date = datetime.fromtimestamp(int(earnings_ts), tz=ny_tz).strftime("%Y-%m-%d")
            except (TypeError, ValueError, OSError):
                next_earnings_date = None

        parsed.append(
            {
                "symbol": sym,
                "tv_symbol": row.get("s") or sym,
                "name": str(m.get("description") or sym),
                "exchange": str(m.get("exchange") or ""),
                "sector": m.get("sector"),
                "close": m.get("close"),
                "price_52w_high": m.get("price_52_week_high"),
                "price_52w_low": m.get("price_52_week_low"),
                "avg_vol_30d": m.get("average_volume_30d_calc"),
                "value_traded": m.get("Value.Traded"),
                "perf_3m": m.get("Perf.3M"),
                "rel_vol_10d": m.get("relative_volume_10d_calc"),
                "next_earnings_date": next_earnings_date,
                "eps_yoy_fq": m.get("earnings_per_share_diluted_yoy_growth_fq") if is_us else None,
                "rev_yoy_fq": m.get("total_revenue_yoy_growth_fq") if is_us else None,
            }
        )
    return parsed


def _pass_52w_filter(item: Dict[str, Any]) -> bool:
    c = item.get("close")
    h52 = item.get("price_52w_high")
    l52 = item.get("price_52w_low")
    if not (c and h52 and l52 and c > 0 and h52 > 0 and l52 > 0):
        return False
    return (c >= h52 * 0.75) and (c >= l52 * 1.30)


def run_stage2_screener(market: str, limit: int = 150) -> List[Dict[str, Any]]:
    """執行 TradingView Scanner Stage 2 初篩，將數千檔壓縮為候選清單。"""
    market = market.upper()
    if market not in ("US", "TW"):
        raise ValueError(f"不支援的市場: {market}")

    cache_file = CACHE_DIR / f"tv_screener_{market}.json"
    is_us = market == "US"
    scanner_market = "america" if is_us else "taiwan"

    try:
        if is_us:
            cols = [
                "name",
                "description",
                "exchange",
                "sector",
                "close",
                "SMA50",
                "SMA150",
                "SMA200",
                "price_52_week_high",
                "price_52_week_low",
                "average_volume_30d_calc",
                "Value.Traded",
                "Perf.3M",
                "relative_volume_10d_calc",
                "earnings_release_next_date",
                "earnings_per_share_diluted_yoy_growth_fq",
                "total_revenue_yoy_growth_fq",
            ]
            payload = {
                "markets": ["america"],
                "symbols": {"query": {"types": ["stock"]}},
                "filter": [
                    {"left": "exchange", "operation": "in_range", "right": ["NASDAQ", "NYSE", "AMEX"]},
                    {"left": "close", "operation": "greater", "right": 10},
                    {"left": "close", "operation": "greater", "right": "SMA50"},
                    {"left": "SMA50", "operation": "greater", "right": "SMA150"},
                    {"left": "SMA150", "operation": "greater", "right": "SMA200"},
                    {"left": "average_volume_30d_calc", "operation": "greater", "right": 300000},
                    {"left": "Value.Traded", "operation": "greater", "right": 10000000},
                ],
                "columns": cols,
                "sort": {"sortBy": "Perf.3M", "sortOrder": "desc"},
                "range": [0, 450],
            }
            resp = _post_tv_scan(scanner_market, payload)
            candidates = [r for r in _parse_tv_rows(resp.get("data") or [], cols, is_us=True) if _pass_52w_filter(r)]
        else:
            # 台股 Scanner 未提供 SMA240 欄位，初篩改採 50/100/200MA；嚴格 60/120/240MA 由核心引擎複核
            cols = [
                "name",
                "description",
                "exchange",
                "sector",
                "close",
                "SMA50",
                "SMA100",
                "SMA200",
                "price_52_week_high",
                "price_52_week_low",
                "average_volume_30d_calc",
                "Value.Traded",
                "Perf.3M",
                "relative_volume_10d_calc",
            ]
            base_payload = {
                "markets": ["taiwan"],
                "symbols": {"query": {"types": ["stock"]}},
                "filter": [
                    {"left": "close", "operation": "greater", "right": 15},
                    {"left": "close", "operation": "greater", "right": "SMA50"},
                    {"left": "SMA50", "operation": "greater", "right": "SMA100"},
                    {"left": "SMA100", "operation": "greater", "right": "SMA200"},
                    {"left": "average_volume_30d_calc", "operation": "greater", "right": 200000},
                    {"left": "Value.Traded", "operation": "greater", "right": 5000000},
                ],
                "columns": cols,
                "sort": {"sortBy": "Perf.3M", "sortOrder": "desc"},
                "range": [0, 450],
            }
            resp = _post_tv_scan(scanner_market, base_payload)
            candidates = [r for r in _parse_tv_rows(resp.get("data") or [], cols, is_us=False) if _pass_52w_filter(r)]

            if len(candidates) < 30:
                supp_payload = dict(base_payload)
                supp_payload["filter"] = [
                    {"left": "close", "operation": "greater", "right": 15},
                    {"left": "close", "operation": "greater", "right": "SMA50"},
                    {"left": "SMA50", "operation": "greater", "right": "SMA200"},
                    {"left": "average_volume_30d_calc", "operation": "greater", "right": 200000},
                    {"left": "Value.Traded", "operation": "greater", "right": 5000000},
                ]
                supp_resp = _post_tv_scan(scanner_market, supp_payload)
                seen = {c["symbol"] for c in candidates}
                for item in _parse_tv_rows(supp_resp.get("data") or [], cols, is_us=False):
                    if item["symbol"] not in seen and _pass_52w_filter(item):
                        candidates.append(item)
                        seen.add(item["symbol"])
                        if len(candidates) >= limit:
                            break

        try:
            cache_file.parent.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError as exc:
            print(f"[tv_screener] 寫入海選快取失敗: {exc}", file=sys.stderr)

        return candidates[:limit]
    except Exception as exc:
        if cache_file.exists():
            print(f"[tv_screener] Screener 連線失敗 ({exc})，改用既有快取", file=sys.stderr)
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            return cached[:limit]
        raise


def fetch_tv_symbol_fundamentals(symbol: str, market: str = "US") -> Dict[str, Any]:
    """查詢單一美股標的之 TradingView 財報日、季度成長與產業欄位。"""
    if market.upper() != "US":
        return {}
    cols = [
        "name",
        "description",
        "exchange",
        "sector",
        "close",
        "price_52_week_high",
        "price_52_week_low",
        "average_volume_30d_calc",
        "Value.Traded",
        "relative_volume_10d_calc",
        "earnings_release_next_date",
        "earnings_per_share_diluted_yoy_growth_fq",
        "total_revenue_yoy_growth_fq",
    ]
    payload = {
        "markets": ["america"],
        "symbols": {"query": {"types": ["stock"]}},
        "filter": [
            {"left": "name", "operation": "equal", "right": symbol.upper()},
            {"left": "exchange", "operation": "in_range", "right": ["NASDAQ", "NYSE", "AMEX"]},
        ],
        "columns": cols,
        "range": [0, 5],
    }
    try:
        resp = _post_tv_scan("america", payload)
        rows = _parse_tv_rows(resp.get("data") or [], cols, is_us=True)
        for item in rows:
            if item["symbol"].upper() == symbol.upper():
                return item
        return rows[0] if rows else {}
    except Exception as exc:
        print(f"[tv_screener] 查詢 {symbol} 基本面失敗: {exc}", file=sys.stderr)
        return {}
