"""美股前復權日 K 與基本面／財報日介面（markets.yaml: US.history_engine = futu_mcp）。

資料來源優先順序：
  1. 新鮮的 Futu 快取（data/cache/futu_US_<symbol>.csv，預設 12 小時內）；
  2. 官方 `futu` CLI（`futu history-kline --autype 1`，前復權 QFQ，取得後更新快取）；
  3. 既有的 Futu 快取（若即時呼叫失敗）；
  4. 本機 FutuOpenD（futu-api，前復權 QFQ，先做 TCP 快檢避免未啟動時無限重連）；
  5. TradingView MCP 匯入快取（data/cache/tv_US_<symbol>.csv）；
  6. yfinance（auto_adjust=True）。
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

import numpy as np
import pandas as pd

from .base import CACHE_DIR, cache_path, market_post_close_cutoff, read_cache, standardize, write_cache

_FUTU_CLI_LOCK = threading.Lock()
_FUTU_LAST_CALL_TS = 0.0
_YF_LOCK = threading.Lock()
_YF_LAST_CALL_TS = 0.0


def save_futu_cache(symbol: str, df: pd.DataFrame, market: str = "US") -> Path:
    """將 Futu 前復權日 K DataFrame 標準化並寫入 data/cache/futu_<market>_<symbol>.csv。"""
    path = cache_path("futu", market, symbol)
    write_cache(path, standardize(df))
    return path


def _find_futu_cli() -> Optional[str]:
    cli = shutil.which("futu")
    if cli:
        return cli
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        win_exe = Path(local_app_data) / "FutuCLI" / "bin" / "futu.exe"
        if win_exe.is_file():
            return str(win_exe)
    unix_bin = Path.home() / ".futu" / "bin" / "futu"
    if unix_bin.is_file():
        return str(unix_bin)
    return None


def _run_futu_cli_cmd(cmd: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    """節流執行 futu CLI 避免多執行緒同時觸發 rate limit。"""
    global _FUTU_LAST_CALL_TS
    for attempt in range(2):
        with _FUTU_CLI_LOCK:
            wait = 0.35 - (time.monotonic() - _FUTU_LAST_CALL_TS)
            if wait > 0:
                time.sleep(wait)
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                check=False,
                timeout=timeout,
            )
            _FUTU_LAST_CALL_TS = time.monotonic()

        if proc.returncode == 0:
            return proc
        err_text = (proc.stderr or proc.stdout or "").lower()
        if "rate_limit" in err_text and attempt == 0:
            time.sleep(3.0)
            continue
        return proc
    return proc


def _futu_cli_history(symbol: str, bars: int) -> pd.DataFrame:
    cli = _find_futu_cli()
    if not cli:
        raise FileNotFoundError("找不到 futu CLI")

    futu_symbol = symbol if "." in symbol else f"US.{symbol.upper()}"
    all_rows: list[dict] = []
    next_time: Optional[int] = None

    for _ in range(5):
        batch = min(max(bars - len(all_rows), 1), 370)
        cmd = [
            cli,
            "history-kline",
            futu_symbol,
            "--ktype",
            "2",
            "--autype",
            "1",
            "--num",
            str(batch),
            "--format",
            "json",
        ]
        if next_time is not None:
            cmd.extend(["--next-time", str(next_time)])

        proc = _run_futu_cli_cmd(cmd, timeout=30)
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or f"exit {proc.returncode}").strip())

        payload = json.loads(proc.stdout)
        data = payload.get("data") or {}
        rows = data.get("kline_list") or []
        if not rows:
            break
        all_rows.extend(rows)

        has_more = bool((payload.get("pagination") or {}).get("has_more"))
        next_time = data.get("next_time")
        if len(all_rows) >= bars or not has_more or not next_time:
            break

    if not all_rows:
        raise RuntimeError(f"futu CLI 未回傳 K 線資料: {futu_symbol}")

    raw_df = pd.DataFrame(all_rows)
    if "date" in raw_df.columns:
        raw_df["date"] = pd.to_datetime(raw_df["date"].astype(str), format="%Y%m%d")
    else:
        raw_df["date"] = pd.to_datetime(raw_df["time_key"], unit="ms", utc=True).dt.tz_convert(
            "America/New_York"
        )

    df = standardize(raw_df[["date", "open", "high", "low", "close", "volume"]])
    try:
        write_cache(cache_path("futu", "US", symbol), df)
    except OSError as exc:
        print(f"[futu_client] 寫入 Futu 快取失敗: {exc}", file=sys.stderr)

    return df.tail(bars).reset_index(drop=True)


def _futu_history(symbol: str, bars: int, host: str = "127.0.0.1", port: int = 11111) -> pd.DataFrame:
    try:
        with socket.create_connection((host, port), timeout=1.0):
            pass
    except OSError as exc:
        raise ConnectionRefusedError(f"OpenD 未啟動 ({host}:{port})") from exc

    from futu import AuType, KLType, OpenQuoteContext, RET_OK  # type: ignore

    ctx = OpenQuoteContext(host=host, port=port)
    try:
        start = (date.today() - timedelta(days=int(bars * 1.6) + 30)).isoformat()
        frames, page_key = [], None
        while True:
            ret, data, page_key = ctx.request_history_kline(
                f"US.{symbol}",
                start=start,
                ktype=KLType.K_DAY,
                autype=AuType.QFQ,
                max_count=1000,
                page_req_key=page_key,
            )
            if ret != RET_OK:
                raise RuntimeError(str(data))
            frames.append(data)
            if page_key is None:
                break
        df = pd.concat(frames).rename(columns={"time_key": "date"})
        return standardize(df[["date", "open", "high", "low", "close", "volume"]])
    finally:
        ctx.close()


def _yf_history(symbol: str, bars: int) -> pd.DataFrame:
    global _YF_LAST_CALL_TS
    with _YF_LOCK:
        wait = 0.20 - (time.monotonic() - _YF_LAST_CALL_TS)
        if wait > 0:
            time.sleep(wait)
        _YF_LAST_CALL_TS = time.monotonic()

    try:
        import yfinance as yf

        df = yf.Ticker(symbol).history(period="3y", interval="1d", auto_adjust=True)
        if not df.empty:
            std = standardize(df.reset_index().rename(columns={"Date": "date", "Datetime": "date"}))
            try:
                write_cache(cache_path("yf_adj", "US", symbol), std)
            except OSError:
                pass
            return std
    except Exception:
        pass

    from .tv_screener import _fetch_yahoo_v8_adjusted

    v8_ticker = symbol.replace(".", "-") if not symbol.startswith("^") else symbol
    std = _fetch_yahoo_v8_adjusted(v8_ticker, bars=max(bars, 330))
    if std.empty:
        raise RuntimeError(f"取不到美股歷史資料: {symbol}")
    try:
        write_cache(cache_path("yf_adj", "US", symbol), std)
    except OSError:
        pass
    return std


def fetch_us_history(symbol: str, bars: int = 330, max_cache_hours: float = 12.0) -> pd.DataFrame:
    expected_us_date, cutoff_ts = market_post_close_cutoff("US")
    futu_path = cache_path("futu", "US", symbol)
    futu_cached = read_cache(
        futu_path,
        max_age_hours=max_cache_hours,
        min_latest_date=expected_us_date,
        min_mtime_ts=cutoff_ts,
    )
    if futu_cached is not None and len(futu_cached) >= 225:
        return futu_cached.tail(bars).reset_index(drop=True)

    try:
        return _futu_cli_history(symbol, bars)
    except Exception as e:
        print(f"[futu_client] futu CLI 不可用 ({type(e).__name__}: {str(e)[:100]})", file=sys.stderr)

    stale_futu = read_cache(futu_path, max_age_hours=10**6)
    if stale_futu is not None and len(stale_futu) >= 225 and stale_futu["date"].max().date() >= expected_us_date:
        return stale_futu.tail(bars).reset_index(drop=True)

    yf_adj_path = cache_path("yf_adj", "US", symbol)
    yf_fresh = read_cache(
        yf_adj_path,
        max_age_hours=max_cache_hours,
        min_latest_date=expected_us_date,
        min_mtime_ts=cutoff_ts,
    )
    if yf_fresh is not None and len(yf_fresh) >= 225:
        return yf_fresh.tail(bars).reset_index(drop=True)

    try:
        df = _futu_history(symbol, bars)
        return df.tail(bars).reset_index(drop=True)
    except Exception as e:
        print(f"[futu_client] OpenD 不可用 ({type(e).__name__}: {str(e)[:80]})", file=sys.stderr)

    try:
        print("[futu_client] 改用 Yahoo 還原價", file=sys.stderr)
        df = _yf_history(symbol, bars)
        return df.tail(bars).reset_index(drop=True)
    except Exception as yf_exc:
        if stale_futu is not None and len(stale_futu) >= 225:
            print("[futu_client] Yahoo 失敗，改用既有 Futu 舊快取", file=sys.stderr)
            return stale_futu.tail(bars).reset_index(drop=True)
        cached = read_cache(cache_path("tv", "US", symbol), max_age_hours=10**6)
        if cached is not None and len(cached) >= 225:
            print("[futu_client] 使用 data/cache 內的 TradingView MCP 匯入資料", file=sys.stderr)
            return cached.tail(bars).reset_index(drop=True)
        stale_yf = read_cache(yf_adj_path, max_age_hours=10**6)
        if stale_yf is not None and len(stale_yf) >= 225:
            print("[futu_client] 使用既有 Yahoo 舊快取", file=sys.stderr)
            return stale_yf.tail(bars).reset_index(drop=True)
        raise yf_exc


def _trading_days_until(target_date_str: Optional[str], ref_date: Optional[date] = None) -> Optional[int]:
    if not target_date_str:
        return None
    try:
        target = date.fromisoformat(str(target_date_str)[:10])
        base = ref_date or date.today()
        return int(np.busday_count(base.isoformat(), target.isoformat()))
    except (ValueError, TypeError):
        return None


def _fetch_futu_quarterly_growth(symbol: str) -> Dict[str, Any]:
    """透過 `futu financials --view statements` 取得最新一季營收與 EPS 成長率。"""
    cli = _find_futu_cli()
    if not cli:
        return {}
    futu_symbol = symbol if "." in symbol else f"US.{symbol.upper()}"
    try:
        proc = subprocess.run(
            [cli, "financials", futu_symbol, "--view", "statements", "--limit", "2", "--format", "json"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
            timeout=15,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return {}
        payload = json.loads(proc.stdout)
        data = payload.get("data") or {}
        reports = data.get("report_list") or data.get("statements") or []
        if not reports:
            for v in data.values():
                if isinstance(v, list) and v:
                    reports = v
                    break
        if not reports or not isinstance(reports[0], dict):
            return {}

        latest = reports[0]
        items = latest.get("item_list") or []
        by_name = {str(it.get("display_name") or "").strip().lower(): it for it in items if isinstance(it, dict)}

        def _pick(candidates: list[str]) -> Optional[Dict[str, Any]]:
            for name in candidates:
                it = by_name.get(name.lower())
                if it is not None:
                    return {
                        "value": it.get("data"),
                        "yoy_pct": round(float(it["yoy"]), 2) if it.get("yoy") is not None else None,
                        "qoq_pct": round(float(it["qoq"]), 2) if it.get("qoq") is not None else None,
                    }
            return None

        rev = _pick(["Total Operating Revenue", "Total Revenue as Reported", "Operating Revenue", "Revenue"])
        diluted_eps = _pick(["Diluted EPS"])
        basic_eps = _pick(["Basic EPS"])
        gross_profit = _pick(["Gross Profit"])

        out: Dict[str, Any] = {"period_text": latest.get("period_text")}
        if rev:
            out["revenue"] = rev
        if diluted_eps:
            out["diluted_eps"] = diluted_eps
        if basic_eps:
            out["basic_eps"] = basic_eps
        if gross_profit:
            out["gross_profit"] = gross_profit
        return out if len(out) > 1 else {}
    except Exception:
        return {}


def build_us_catalysts(
    symbol: str,
    screener_row: Optional[Dict[str, Any]] = None,
    earnings_warning_days: int = 7,
    fetch_futu_financials: bool = False,
) -> Dict[str, Any]:
    """組合美股第 3 關催化劑（財報日防雷、營收/EPS YoY 與 Futu 季報明細）。"""
    row = screener_row
    if row is None:
        from .tv_screener import fetch_tv_symbol_fundamentals

        row = fetch_tv_symbol_fundamentals(symbol, market="US")

    next_earnings_date = row.get("next_earnings_date") if row else None
    days_to_earnings = _trading_days_until(next_earnings_date)
    earnings_warning = days_to_earnings is not None and 0 <= days_to_earnings <= earnings_warning_days

    eps_yoy = row.get("eps_yoy_fq") if row else None
    rev_yoy = row.get("rev_yoy_fq") if row else None
    futu_q = _fetch_futu_quarterly_growth(symbol) if fetch_futu_financials else {}

    return {
        "source": "TradingView+FutuCLI" if futu_q else "TradingView",
        "sector": row.get("sector") if row else None,
        "next_earnings_date": next_earnings_date,
        "trading_days_to_earnings": days_to_earnings,
        "earnings_warning": earnings_warning,
        "warning_flag": "EARNINGS_WARNING" if earnings_warning else None,
        "eps_yoy_fq_pct": round(float(eps_yoy), 2) if eps_yoy is not None else None,
        "revenue_yoy_fq_pct": round(float(rev_yoy), 2) if rev_yoy is not None else None,
        "latest_quarter": futu_q or None,
    }


def fetch_us_chinese_names(symbols: Sequence[str]) -> Dict[str, str]:
    """透過 `futu basicinfo` 批次查詢美股繁體中文名稱並快取於 data/cache/us_names_zh.json。"""
    cache_file = CACHE_DIR / "us_names_zh.json"
    cache: Dict[str, str] = {}
    if cache_file.exists():
        try:
            loaded = json.loads(cache_file.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                cache = {str(k).upper(): str(v) for k, v in loaded.items() if v}
        except Exception:
            pass

    seen = set()
    missing: list[str] = []
    for s in symbols:
        sym = str(s).strip().upper()
        if sym and sym not in seen and sym not in cache:
            seen.add(sym)
            missing.append(sym)

    if missing:
        try:
            cli = _find_futu_cli()
        except OSError:
            cli = None
        if cli:
            updated = False
            for i in range(0, len(missing), 50):
                batch = missing[i : i + 50]
                try:
                    proc = subprocess.run(
                        [cli, "basicinfo", *[f"US.{s}" for s in batch], "--format", "json"],
                        capture_output=True,
                        text=True,
                        encoding="utf-8",
                        check=False,
                        timeout=20,
                    )
                    if proc.returncode != 0 or not proc.stdout.strip():
                        continue
                    payload = json.loads(proc.stdout)
                    items = payload.get("basic_list") or (payload.get("data") or {}).get("basic_list") or []
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        code = str(item.get("code") or "")
                        sym = code.split(".", 1)[1].upper() if "." in code else code.upper()
                        zh = str(item.get("tc_name") or item.get("sc_name") or item.get("name") or "").strip()
                        if sym and zh:
                            cache[sym] = zh
                            updated = True
                except Exception:
                    continue

            if updated:
                try:
                    cache_file.parent.mkdir(parents=True, exist_ok=True)
                    cache_file.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
                except OSError:
                    pass

    return {str(s): cache.get(str(s).strip().upper(), "") for s in symbols}
