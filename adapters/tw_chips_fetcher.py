"""台股盤後籌碼與月營收補強介面（證交所 TWSE ＋ 櫃買中心 TPEx）。

抓取項目：
  1. 三大法人買賣超（外資、投信、自營商；上市提供最新 1 日與近 5 日彙總及投信連買天數）；
  2. 融資融券餘額與增減張數；
  3. 最新公告月營收、MoM% 與 YoY%。
"""
from __future__ import annotations

import json
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .base import CACHE_DIR

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def _ssl_context() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return ctx


def _tw_today() -> datetime.date:
    try:
        tz = ZoneInfo("Asia/Taipei")
    except ZoneInfoNotFoundError:
        tz = timezone(timedelta(hours=8))
    return datetime.now(tz).date()


def _get_json(url: str, timeout: int = 12) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _parse_num_str(val: Any) -> str:
    return str(val or "").replace(",", "").strip()


def _parse_int(val: Any, default: int = 0) -> int:
    s = _parse_num_str(val)
    if s in ("", "-", "--", "N/A", "NaN", "None"):
        return default
    try:
        return int(round(float(s)))
    except ValueError:
        return default


def _parse_float(val: Any) -> Optional[float]:
    s = _parse_num_str(val)
    if s in ("", "-", "--", "N/A", "NaN", "None"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _get_no_space(row: Dict[str, Any], target_no_space: str) -> Any:
    for k, v in row.items():
        if k.replace(" ", "") == target_no_space:
            return v
    return None


def _fetch_twse_t86_days(t86_days: int = 10) -> List[Tuple[str, Dict[str, Dict[str, Any]]]]:
    today = _tw_today()
    today_str = today.strftime("%Y%m%d")
    collected: List[Tuple[str, Dict[str, Dict[str, Any]]]] = []

    for offset in range(25):
        if len(collected) >= t86_days:
            break
        ymd = (today - timedelta(days=offset)).strftime("%Y%m%d")
        day_cache = CACHE_DIR / f"twse_t86_{ymd}.json"

        use_cache = False
        if day_cache.exists():
            if ymd != today_str or (time.time() - day_cache.stat().st_mtime) < 12 * 3600:
                use_cache = True

        if use_cache:
            try:
                day_map = json.loads(day_cache.read_text(encoding="utf-8"))
                sample = next(iter(day_map.values()), {}) if isinstance(day_map, dict) else {}
                if day_map and isinstance(sample, dict) and "name_zh" in sample:
                    collected.append((ymd, day_map))
                    continue
            except Exception:
                pass

        try:
            url = f"https://www.twse.com.tw/rwd/zh/fund/T86?response=json&selectType=ALLBUT0999&date={ymd}"
            resp = _get_json(url)
            if resp.get("stat") != "OK" or not resp.get("data"):
                continue

            day_map: Dict[str, Dict[str, Any]] = {}
            for row in resp["data"]:
                if len(row) < 19:
                    continue
                code = str(row[0]).strip()
                if not code:
                    continue
                foreign_shares = _parse_int(row[4]) + _parse_int(row[7])
                trust_shares = _parse_int(row[10])
                dealer_shares = _parse_int(row[11])
                total_shares = _parse_int(row[18])
                day_map[code] = {
                    "name_zh": str(row[1]).strip() or None,
                    "foreign": int(round(foreign_shares / 1000.0)),
                    "trust": int(round(trust_shares / 1000.0)),
                    "dealer": int(round(dealer_shares / 1000.0)),
                    "total": int(round(total_shares / 1000.0)),
                }

            if day_map:
                try:
                    day_cache.parent.mkdir(parents=True, exist_ok=True)
                    day_cache.write_text(json.dumps(day_map, ensure_ascii=False), encoding="utf-8")
                except OSError:
                    pass
                collected.append((ymd, day_map))
        except Exception as exc:
            print(f"[tw_chips_fetcher] T86 ({ymd}) 抓取失敗: {exc}", file=sys.stderr)
            continue

    return collected


def _fetch_twse_margin(ymd: str) -> Dict[str, Dict[str, int]]:
    url = f"https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&selectType=ALL&date={ymd}"
    resp = _get_json(url)
    if resp.get("stat") != "OK":
        return {}

    target_rows = []
    for tbl in resp.get("tables") or []:
        fields = tbl.get("fields") or []
        if fields and str(fields[0]).strip() == "代號":
            target_rows = tbl.get("data") or []
            break

    out: Dict[str, Dict[str, int]] = {}
    for row in target_rows:
        if len(row) < 13:
            continue
        code = str(row[0]).strip()
        if not code:
            continue
        m_prev = _parse_int(row[5])
        m_today = _parse_int(row[6])
        s_prev = _parse_int(row[11])
        s_today = _parse_int(row[12])
        out[code] = {
            "margin_balance_lots": m_today,
            "margin_change_lots": m_today - m_prev,
            "short_balance_lots": s_today,
            "short_change_lots": s_today - s_prev,
        }
    return out


def _fetch_tpex_inst() -> Tuple[Optional[str], Dict[str, Dict[str, int]], Dict[str, str]]:
    rows = _get_json("https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading")
    if not isinstance(rows, list):
        return None, {}, {}
    out: Dict[str, Dict[str, int]] = {}
    names: Dict[str, str] = {}
    latest_date: Optional[str] = None
    for row in rows:
        code = str(row.get("SecuritiesCompanyCode") or "").strip()
        if not code:
            continue
        if not latest_date and row.get("Date"):
            latest_date = str(row["Date"]).strip()
        comp_name = str(row.get("CompanyName") or "").strip()
        if comp_name:
            names[code] = comp_name
        f_raw = (
            row.get("ForeignInvestorsInclude MainlandAreaInvestors-Difference")
            or row.get("Foreign Investors include Mainland Area Investors (Foreign Dealers excluded)-Difference")
            or _get_no_space(row, "ForeignInvestorsIncludeMainlandAreaInvestors-Difference")
            or 0
        )
        t_raw = (
            row.get("SecuritiesInvestmentTrustCompanies-Difference")
            or _get_no_space(row, "SecuritiesInvestmentTrustCompanies-Difference")
            or 0
        )
        d_raw = row.get("Dealers-Difference") or _get_no_space(row, "Dealers-Difference") or 0
        tot_raw = row.get("TotalDifference") or _get_no_space(row, "TotalDifference") or 0
        out[code] = {
            "foreign": int(round(_parse_int(f_raw) / 1000.0)),
            "trust": int(round(_parse_int(t_raw) / 1000.0)),
            "dealer": int(round(_parse_int(d_raw) / 1000.0)),
            "total": int(round(_parse_int(tot_raw) / 1000.0)),
        }
    return latest_date, out, names


def _fetch_tpex_margin() -> Dict[str, Dict[str, Any]]:
    rows = _get_json("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance")
    if not isinstance(rows, list):
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        code = str(row.get("SecuritiesCompanyCode") or "").strip()
        if not code:
            continue
        m_prev = _parse_int(row.get("MarginPurchaseBalancePreviousDay"))
        m_today = _parse_int(row.get("MarginPurchaseBalance"))
        s_prev = _parse_int(row.get("ShortSaleBalancePreviousDay"))
        s_today = _parse_int(row.get("ShortSaleBalance"))
        util = _parse_float(row.get("MarginPurchaseUtilizationRate"))
        out[code] = {
            "margin_balance_lots": m_today,
            "margin_change_lots": m_today - m_prev,
            "short_balance_lots": s_today,
            "short_change_lots": s_today - s_prev,
            "margin_utilization_pct": round(util, 2) if util is not None else None,
        }
    return out


def _parse_revenue_rows(rows: Any) -> Dict[str, Dict[str, Any]]:
    if not isinstance(rows, list):
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        code = str(row.get("公司代號") or "").strip()
        if not code:
            continue
        mom = _parse_float(row.get("營業收入-上月比較增減(%)"))
        yoy = _parse_float(row.get("營業收入-去年同月增減(%)"))
        cum_yoy = _parse_float(row.get("累計營業收入-前期比較增減(%)"))
        rev_k = _parse_int(row.get("營業收入-當月營收"))
        out[code] = {
            "name_zh": str(row.get("公司名稱") or "").strip() or None,
            "industry": str(row.get("產業別") or "").strip() or None,
            "monthly_revenue": {
                "year_month": str(row.get("資料年月") or "").strip() or None,
                "revenue_thousand_twd": rev_k,
                "mom_pct": round(mom, 2) if mom is not None else None,
                "yoy_pct": round(yoy, 2) if yoy is not None else None,
                "cum_yoy_pct": round(cum_yoy, 2) if cum_yoy is not None else None,
            },
        }
    return out


def _normalize_tpex_ymd(raw_date: Optional[str]) -> str:
    s = str(raw_date or "").strip()
    if "/" in s:
        parts = s.split("/")
        if len(parts) == 3 and all(p.isdigit() for p in parts):
            yr = int(parts[0])
            if yr < 1911:
                yr += 1911
            return f"{yr:04d}{int(parts[1]):02d}{int(parts[2]):02d}"
    digits = "".join(ch for ch in s if ch.isdigit())
    if len(digits) == 7:
        return f"{int(digits[:3]) + 1911:04d}{digits[3:]}"
    if len(digits) == 8:
        return digits
    return _tw_today().strftime("%Y%m%d")


def _parse_tpex_daily_trade(resp: Any) -> Dict[str, Dict[str, Any]]:
    if not isinstance(resp, dict):
        return {}
    tables = resp.get("tables") or []
    fields: List[str] = []
    rows: List[List[Any]] = []
    if tables and isinstance(tables[0], dict):
        fields = [str(f).replace(" ", "") for f in (tables[0].get("fields") or [])]
        rows = tables[0].get("data") or []
    elif resp.get("aaData"):
        rows = resp.get("aaData") or []

    if not rows:
        return {}

    def _find_idx(must_include: Tuple[str, ...], exclude: Tuple[str, ...] = ()) -> Optional[int]:
        for idx, col in enumerate(fields):
            if all(m in col for m in must_include) and not any(ex in col for ex in exclude):
                return idx
        return None

    f_idx = _find_idx(("外資及陸資", "買賣超"), ("不含", "自營商"))
    if f_idx is None:
        f_idx = _find_idx(("外資及陸資(不含外資自營商)", "買賣超"))
    t_idx = _find_idx(("投信", "買賣超"))
    d_idx = _find_idx(("自營商", "買賣超"), ("外資", "自行", "避險"))
    tot_idx = _find_idx(("三大法人買賣超",))

    day_map: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, list) or len(row) < 10:
            continue
        code = str(row[0]).strip()
        if not code:
            continue
        name_zh = str(row[1]).strip() or None
        if f_idx is not None and t_idx is not None and tot_idx is not None:
            f_shares = _parse_int(row[f_idx])
            t_shares = _parse_int(row[t_idx])
            tot_shares = _parse_int(row[tot_idx])
            d_shares = _parse_int(row[d_idx]) if d_idx is not None else (tot_shares - f_shares - t_shares)
        else:
            # 欄位退回預設索引（TPEx dailyTrade 常見結構：股數）
            f_shares = _parse_int(row[10]) if len(row) > 10 else 0
            t_shares = _parse_int(row[13]) if len(row) > 13 else 0
            tot_shares = _parse_int(row[-1])
            d_shares = tot_shares - f_shares - t_shares
        day_map[code] = {
            "name_zh": name_zh,
            "foreign": int(round(f_shares / 1000.0)),
            "trust": int(round(t_shares / 1000.0)),
            "dealer": int(round(d_shares / 1000.0)),
            "total": int(round(tot_shares / 1000.0)),
        }
    return day_map


def _fetch_tpex_inst_days(days: int = 10) -> List[Tuple[str, Dict[str, Dict[str, Any]]]]:
    by_ymd: Dict[str, Dict[str, Dict[str, Any]]] = {}

    # 1. 先抓取 TPEx OpenAPI 最新一日並寫入日快取
    try:
        tpex_date, tpex_inst, tpex_names = _fetch_tpex_inst()
        if tpex_inst:
            ymd = _normalize_tpex_ymd(tpex_date)
            merged_day = {
                code: {**vals, "name_zh": tpex_names.get(code)}
                for code, vals in tpex_inst.items()
            }
            by_ymd[ymd] = merged_day
            day_cache = CACHE_DIR / f"tpex_inst_{ymd}.json"
            try:
                day_cache.parent.mkdir(parents=True, exist_ok=True)
                day_cache.write_text(json.dumps(merged_day, ensure_ascii=False), encoding="utf-8")
            except OSError:
                pass
    except Exception as exc:
        print(f"[tw_chips_fetcher] TPEx OpenAPI 三大法人抓取失敗: {exc}", file=sys.stderr)

    # 2. 讀取既有本地 tpex_inst_*.json 快取並回補不足的近 10 日交易資料
    today = _tw_today()
    for offset in range(25):
        if len(by_ymd) >= days:
            break
        dt = today - timedelta(days=offset)
        if dt.weekday() >= 5:
            continue
        ymd = dt.strftime("%Y%m%d")
        if ymd in by_ymd:
            continue

        day_cache = CACHE_DIR / f"tpex_inst_{ymd}.json"
        if day_cache.exists():
            try:
                cached_day = json.loads(day_cache.read_text(encoding="utf-8"))
                if isinstance(cached_day, dict) and cached_day:
                    by_ymd[ymd] = cached_day
                    continue
            except Exception:
                pass

        try:
            date_param = dt.strftime("%Y/%m/%d")
            url = (
                "https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade"
                f"?type=Daily&sect=EW&date={date_param}&id=&response=json"
            )
            parsed = _parse_tpex_daily_trade(_get_json(url, timeout=10))
            if parsed:
                by_ymd[ymd] = parsed
                try:
                    day_cache.parent.mkdir(parents=True, exist_ok=True)
                    day_cache.write_text(json.dumps(parsed, ensure_ascii=False), encoding="utf-8")
                except OSError:
                    pass
        except Exception:
            continue

    ordered_ymds = sorted(by_ymd.keys(), reverse=True)[:days]
    return [(ymd, by_ymd[ymd]) for ymd in ordered_ymds]


def _aggregate_inst_days(
    days_list: List[Tuple[str, Dict[str, Dict[str, Any]]]],
    code: str,
) -> Tuple[Optional[Dict[str, int]], Optional[Dict[str, int]], Optional[Dict[str, int]], int, int]:
    """將多日三大法人資料彙總為 1 日、5 日、10 日淨買超與投信連買天數。"""
    if not days_list:
        return None, None, None, 0, 0

    raw_1d = days_list[0][1].get(code)
    inst_1d = {k: int(raw_1d[k]) for k in ("foreign", "trust", "dealer", "total")} if raw_1d else None

    def _sum_window(slice_days: List[Tuple[str, Dict[str, Dict[str, Any]]]]) -> Optional[Dict[str, int]]:
        agg = {"foreign": 0, "trust": 0, "dealer": 0, "total": 0}
        has_any = False
        for _, dmap in slice_days:
            row = dmap.get(code)
            if row:
                has_any = True
                for k in ("foreign", "trust", "dealer", "total"):
                    agg[k] += int(row.get(k) or 0)
        return agg if has_any else None

    inst_5d = _sum_window(days_list[:5])
    inst_10d = _sum_window(days_list[:10])

    streak = 0
    for _, dmap in days_list:
        row = dmap.get(code)
        if row and int(row.get("trust") or 0) > 0:
            streak += 1
        else:
            break

    return inst_1d, inst_5d, inst_10d, streak, len(days_list)


def load_tw_chips_snapshot(max_cache_hours: float = 12.0, t86_days: int = 10) -> Dict[str, Dict[str, Any]]:
    """載入台股全市場（上市＋上櫃）籌碼（含近 10 日三大法人累計）與月營收快照。"""
    snapshot_path = CACHE_DIR / "tw_chips_snapshot.json"
    if snapshot_path.exists() and (time.time() - snapshot_path.stat().st_mtime) < max_cache_hours * 3600:
        try:
            cached = json.loads(snapshot_path.read_text(encoding="utf-8"))
            sample = next(iter(cached.values()), {}) if isinstance(cached, dict) else {}
            if isinstance(sample, dict) and "name_zh" in sample and "institutional_10d_lots" in sample:
                return cached
        except Exception:
            pass

    twse_days: List[Tuple[str, Dict[str, Dict[str, Any]]]] = []
    twse_margin: Dict[str, Dict[str, int]] = {}
    twse_rev: Dict[str, Dict[str, Any]] = {}
    tpex_days: List[Tuple[str, Dict[str, Dict[str, Any]]]] = []
    tpex_margin: Dict[str, Dict[str, Any]] = {}
    tpex_rev: Dict[str, Dict[str, Any]] = {}

    try:
        twse_days = _fetch_twse_t86_days(t86_days=t86_days)
    except Exception as exc:
        print(f"[tw_chips_fetcher] TWSE T86 抓取失敗: {exc}", file=sys.stderr)

    latest_twse_date = twse_days[0][0] if twse_days else None
    if latest_twse_date:
        try:
            twse_margin = _fetch_twse_margin(latest_twse_date)
        except Exception as exc:
            print(f"[tw_chips_fetcher] TWSE MI_MARGN 抓取失敗: {exc}", file=sys.stderr)

    try:
        twse_rev = _parse_revenue_rows(_get_json("https://openapi.twse.com.tw/v1/opendata/t187ap05_L"))
    except Exception as exc:
        print(f"[tw_chips_fetcher] TWSE 月營收抓取失敗: {exc}", file=sys.stderr)

    try:
        tpex_days = _fetch_tpex_inst_days(days=t86_days)
    except Exception as exc:
        print(f"[tw_chips_fetcher] TPEx 三大法人抓取失敗: {exc}", file=sys.stderr)

    try:
        tpex_margin = _fetch_tpex_margin()
    except Exception as exc:
        print(f"[tw_chips_fetcher] TPEx 融資融券抓取失敗: {exc}", file=sys.stderr)

    try:
        tpex_rev = _parse_revenue_rows(_get_json("https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O"))
    except Exception as exc:
        print(f"[tw_chips_fetcher] TPEx 月營收抓取失敗: {exc}", file=sys.stderr)

    snapshot: Dict[str, Dict[str, Any]] = {}

    twse_latest_inst = twse_days[0][1] if twse_days else {}
    twse_codes = set(twse_latest_inst.keys()) | set(twse_margin.keys()) | set(twse_rev.keys())
    for code in twse_codes:
        raw_1d = twse_latest_inst.get(code)
        inst_name_zh = raw_1d.get("name_zh") if raw_1d else None
        inst_1d, inst_5d, inst_10d, streak, days_avail = _aggregate_inst_days(twse_days, code)
        rev_info = twse_rev.get(code, {})
        snapshot[code] = {
            "source": "TWSE",
            "market_board": "TWSE",
            "name_zh": rev_info.get("name_zh") or inst_name_zh or None,
            "data_date": latest_twse_date,
            "industry": rev_info.get("industry"),
            "monthly_revenue": rev_info.get("monthly_revenue"),
            "institutional_1d_lots": inst_1d,
            "institutional_5d_lots": inst_5d,
            "institutional_10d_lots": inst_10d,
            "institutional_days_available": days_avail,
            "trust_buy_streak_days": streak,
            "margin": twse_margin.get(code),
        }

    tpex_latest_inst = tpex_days[0][1] if tpex_days else {}
    tpex_date = tpex_days[0][0] if tpex_days else None
    tpex_codes = set(tpex_latest_inst.keys()) | set(tpex_margin.keys()) | set(tpex_rev.keys())
    for code in tpex_codes:
        if code in snapshot:
            continue
        raw_1d = tpex_latest_inst.get(code)
        inst_name_zh = raw_1d.get("name_zh") if raw_1d else None
        inst_1d, inst_5d, inst_10d, streak, days_avail = _aggregate_inst_days(tpex_days, code)
        rev_info = tpex_rev.get(code, {})
        snapshot[code] = {
            "source": "TPEX",
            "market_board": "TPEX",
            "name_zh": rev_info.get("name_zh") or inst_name_zh or None,
            "data_date": tpex_date,
            "industry": rev_info.get("industry"),
            "monthly_revenue": rev_info.get("monthly_revenue"),
            "institutional_1d_lots": inst_1d,
            "institutional_5d_lots": inst_5d,
            "institutional_10d_lots": inst_10d,
            "institutional_days_available": days_avail,
            "trust_buy_streak_days": streak,
            "margin": tpex_margin.get(code),
        }

    if snapshot:
        try:
            snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
        except OSError as exc:
            print(f"[tw_chips_fetcher] 寫入籌碼快照失敗: {exc}", file=sys.stderr)

    return snapshot


def fetch_tw_catalysts(symbol: str, snapshot: Optional[Dict[str, Dict[str, Any]]] = None) -> Dict[str, Any]:
    """取得單一台股標的之第 3 關機構籌碼與月營收摘要。"""
    code = symbol.split(".")[0].strip()
    data = snapshot if snapshot is not None else load_tw_chips_snapshot()
    entry = data.get(code)
    if not entry:
        return {"status": "NOT_FOUND_IN_TWSE_TPEX", "symbol": code}
    return dict(entry)


def is_tw_listed_or_otc(symbol: str, snapshot: Optional[Dict[str, Dict[str, Any]]]) -> bool:
    """確認標的屬於上市 (TWSE) 或上櫃主板 (TPEX)，排除興櫃 (OES)。若快照為空則放行避免外部 API 異常誤殺。"""
    if not snapshot:
        return True
    code = symbol.split(".")[0].strip()
    entry = snapshot.get(code)
    return bool(entry and entry.get("market_board") in ("TWSE", "TPEX"))
