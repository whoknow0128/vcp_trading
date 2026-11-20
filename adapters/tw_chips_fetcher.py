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


def _fetch_twse_t86_days(t86_days: int = 5) -> List[Tuple[str, Dict[str, Dict[str, int]]]]:
    today = _tw_today()
    today_str = today.strftime("%Y%m%d")
    collected: List[Tuple[str, Dict[str, Dict[str, int]]]] = []

    for offset in range(14):
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


def load_tw_chips_snapshot(max_cache_hours: float = 12.0, t86_days: int = 5) -> Dict[str, Dict[str, Any]]:
    """載入台股全市場（上市＋上櫃）籌碼與月營收快照。"""
    snapshot_path = CACHE_DIR / "tw_chips_snapshot.json"
    if snapshot_path.exists() and (time.time() - snapshot_path.stat().st_mtime) < max_cache_hours * 3600:
        try:
            cached = json.loads(snapshot_path.read_text(encoding="utf-8"))
            sample = next(iter(cached.values()), {}) if isinstance(cached, dict) else {}
            if isinstance(sample, dict) and "name_zh" in sample:
                return cached
        except Exception:
            pass

    twse_days: List[Tuple[str, Dict[str, Dict[str, Any]]]] = []
    twse_margin: Dict[str, Dict[str, int]] = {}
    twse_rev: Dict[str, Dict[str, Any]] = {}
    tpex_date: Optional[str] = None
    tpex_inst: Dict[str, Dict[str, int]] = {}
    tpex_names: Dict[str, str] = {}
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
        tpex_date, tpex_inst, tpex_names = _fetch_tpex_inst()
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
        inst_1d = {k: raw_1d[k] for k in ("foreign", "trust", "dealer", "total")} if raw_1d else None
        inst_name_zh = raw_1d.get("name_zh") if raw_1d else None
        inst_5d = None
        streak = 0
        if twse_days:
            agg = {"foreign": 0, "trust": 0, "dealer": 0, "total": 0}
            has_any = False
            streak_broken = False
            for _, dmap in twse_days:
                row = dmap.get(code)
                if row:
                    has_any = True
                    for k in ("foreign", "trust", "dealer", "total"):
                        agg[k] += row[k]
                    if not streak_broken and row["trust"] > 0:
                        streak += 1
                    else:
                        streak_broken = True
                else:
                    streak_broken = True
            if has_any:
                inst_5d = agg

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
            "trust_buy_streak_days": streak,
            "margin": twse_margin.get(code),
        }

    tpex_codes = set(tpex_inst.keys()) | set(tpex_margin.keys()) | set(tpex_rev.keys())
    for code in tpex_codes:
        if code in snapshot:
            continue
        rev_info = tpex_rev.get(code, {})
        inst_1d = tpex_inst.get(code)
        streak = 1 if (inst_1d and inst_1d.get("trust", 0) > 0) else 0
        snapshot[code] = {
            "source": "TPEX",
            "market_board": "TPEX",
            "name_zh": rev_info.get("name_zh") or tpex_names.get(code) or None,
            "data_date": tpex_date,
            "industry": rev_info.get("industry"),
            "monthly_revenue": rev_info.get("monthly_revenue"),
            "institutional_1d_lots": inst_1d,
            "institutional_5d_lots": None,
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
