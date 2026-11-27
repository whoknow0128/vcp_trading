"""模式 B：盤後全市場漏斗海選。  python -m runners.run_post_market_scan --market US|TW"""
from __future__ import annotations

import argparse
import json
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import yaml  # noqa: E402

from adapters.base import market_post_close_cutoff  # noqa: E402
from adapters.futu_client import (  # noqa: E402
    _fetch_futu_quarterly_growth,
    build_us_catalysts,
    fetch_us_chinese_names,
    fetch_us_history,
)
from adapters.tv_screener import fetch_tw_history, run_stage2_screener  # noqa: E402
from adapters.tw_chips_fetcher import (  # noqa: E402
    expected_tw_chips_date,
    fetch_tw_catalysts,
    is_tw_listed_or_otc,
    load_tw_chips_snapshot,
)
from core.calc_vcp_metrics import calculate_vcp_metrics  # noqa: E402

_TIER_PRIORITY = {
    "S": 3,
    "A": 2,
    "B": 1,
    "C": 0,
}

_STATUS_PRIORITY = {
    "BREAKOUT": 3,
    "PIVOT_READY": 2,
    "CONSOLIDATING": 1,
    "EXTENDED": 0,
    "NONE": 0,
}

_GRADE_PRIORITY = {
    "A_CANDIDATE": 4,
    "B_WATCHLIST": 3,
    "B_EARNINGS_WARNING": 2,
    "B_OR_C_REVIEW": 2,
    "C_EARNINGS_WARNING": 1,
    "C": 0,
}

_EARNINGS_DOWNGRADE = {
    "A_CANDIDATE": "B_EARNINGS_WARNING",
    "B_WATCHLIST": "C_EARNINGS_WARNING",
    "B_OR_C_REVIEW": "C_EARNINGS_WARNING",
}


def _now_taipei() -> datetime:
    try:
        tz = ZoneInfo("Asia/Taipei")
    except ZoneInfoNotFoundError:
        tz = timezone(timedelta(hours=8))
    return datetime.now(tz)


def _assign_rs_ratings(evaluated: List[Dict[str, Any]]) -> None:
    """依各標的之相對強度原始分數計算橫斷面百分位 RS Rating (1~99)。"""
    n = len(evaluated)
    if n == 0:
        return
    if n == 1:
        evaluated[0]["result"]["gate2_trend_rs"]["rs_rating"] = 99
        return

    ranked = sorted(
        evaluated,
        key=lambda x: float(x["result"]["gate2_trend_rs"].get("rs_raw_score") or 0.0),
    )
    for idx, item in enumerate(ranked):
        rating = max(1, min(99, int(round(1 + (idx / (n - 1)) * 98))))
        item["result"]["gate2_trend_rs"]["rs_rating"] = rating


def _has_catalyst_resonance(g3: Dict[str, Any], market: str) -> bool:
    if market == "TW":
        inst = g3.get("institutional_10d_lots") or g3.get("institutional_5d_lots") or g3.get("institutional_1d_lots") or {}
        if (inst.get("trust") or 0) > 0 or (inst.get("foreign") or 0) > 0:
            return True
        rev_yoy = (g3.get("monthly_revenue") or {}).get("yoy_pct")
        return rev_yoy is not None and float(rev_yoy) > 15.0
    eps_yoy = g3.get("eps_yoy_fq_pct")
    rev_yoy = g3.get("revenue_yoy_fq_pct")
    return (eps_yoy is not None and float(eps_yoy) > 15.0) or (rev_yoy is not None and float(rev_yoy) > 15.0)


def _classify_vcp_tier(
    res: Dict[str, Any],
    market: str,
    evaluated_count: int,
    has_earnings_warn: bool,
) -> str:
    """依收縮次數、量縮程度、樞紐狀態、RS Rating 與法人／基本面共振評定 S / A / B / C 級。"""
    g2 = res["gate2_trend_rs"]
    g3 = res.get("gate3_catalysts") or {}
    g4 = res["gate4_setup_risk"]

    if (
        not g2.get("stage2_template_pass")
        or int(g4.get("distribution_days_10d", 0)) >= 3
        or float(g4.get("dist_from_10ma_in_atr", 0.0)) > 3.5
    ):
        return "C"

    status = str(g4.get("setup_status") or "CONSOLIDATING")
    steps = int(g4.get("contraction_steps", 0))
    tight_vcp = bool(g4.get("range_contracting") and g4.get("range_5d_tight")) or (
        float(g4.get("bbw_120d_percentile", 100.0)) <= 25.0
        and float(g4.get("atr_5_20_ratio", 1.0)) <= 0.75
        and float(g4.get("tightness_10d_pct", 100.0)) <= 10.0
    )
    has_vdu = bool(g4.get("is_vdu_5d") or g4.get("is_vdu_3d") or g4.get("pocket_pivot_in_5d"))
    rs_rating = g2.get("rs_rating")
    rs_ok = True if (evaluated_count < 4 or rs_rating is None) else int(rs_rating) >= 75
    resonance = _has_catalyst_resonance(g3, market)

    if (
        not has_earnings_warn
        and rs_ok
        and (steps >= 2 or tight_vcp)
        and has_vdu
        and resonance
        and status in ("BREAKOUT", "PIVOT_READY")
    ):
        return "S"
    if not has_earnings_warn and (tight_vcp or status in ("BREAKOUT", "PIVOT_READY")) and (has_vdu or resonance):
        return "A"
    return "B"


def _score_candidate(result: Dict[str, Any], market: str) -> int:
    g2 = result["gate2_trend_rs"]
    g3 = result.get("gate3_catalysts") or {}
    g4 = result["gate4_setup_risk"]

    score = 0
    if g2.get("stage2_template_pass"):
        score += 30
    if g2.get("rs_line_52w_high"):
        score += 12
    if g2.get("rs_above_ma50"):
        score += 6

    rs_rating = g2.get("rs_rating")
    if rs_rating is not None:
        if int(rs_rating) >= 75:
            score += 10
        elif int(rs_rating) < 50:
            score -= 10

    bbw_pct = float(g4.get("bbw_120d_percentile", 100.0))
    if bbw_pct <= 25.0:
        score += 12
    elif bbw_pct <= 40.0:
        score += 5

    atr_ratio = float(g4.get("atr_5_20_ratio", 1.0))
    if atr_ratio <= 0.75:
        score += 10
    elif atr_ratio <= 0.90:
        score += 4

    if g4.get("atr14_low_60d"):
        score += 5

    tight = float(g4.get("tightness_10d_pct", 100.0))
    if tight <= 10.0:
        score += 6
    elif tight <= 15.0:
        score += 2

    if g4.get("range_contracting"):
        score += 8
    if g4.get("range_5d_tight"):
        score += 5

    if g4.get("is_vdu_5d"):
        score += 6
    elif g4.get("is_vdu_3d") or g4.get("pocket_pivot_in_5d"):
        score += 4
    if g4.get("price_above_bb_mid"):
        score += 4

    status = str(g4.get("setup_status") or "")
    if status == "BREAKOUT":
        score += 12
    elif status == "PIVOT_READY":
        score += 10

    if int(g4.get("distribution_days_10d", 0)) >= 3:
        score -= 15
    if float(g4.get("dist_from_10ma_in_atr", 0.0)) > 3.5:
        score -= 10

    adr_pct = float(g4.get("adr_20d_pct", 5.0))
    if adr_pct < 2.0:
        score -= 15
    elif adr_pct > 10.0:
        score -= 10

    if market == "TW":
        inst = g3.get("institutional_10d_lots") or g3.get("institutional_5d_lots") or g3.get("institutional_1d_lots") or {}
        trust_net = inst.get("trust") or 0
        foreign_net = inst.get("foreign") or 0
        if trust_net > 0 and foreign_net > 0:
            score += 6
        elif trust_net > 0 or foreign_net > 0:
            score += 4
        rev_yoy = (g3.get("monthly_revenue") or {}).get("yoy_pct")
        if rev_yoy is not None and float(rev_yoy) > 15.0:
            score += 4
    else:
        eps_yoy = g3.get("eps_yoy_fq_pct")
        rev_yoy = g3.get("revenue_yoy_fq_pct")
        if eps_yoy is not None and float(eps_yoy) > 15.0:
            score += 4
        if rev_yoy is not None and float(rev_yoy) > 15.0:
            score += 4

    return max(0, min(100, score))


def run_scan(
    market: str,
    max_candidates: int = 150,
    focus_min: int = 0,
    focus_max: int = 15,
    bars: int = 330,
) -> Dict[str, Any]:
    market = market.upper()
    cfg = yaml.safe_load((ROOT / "config" / "markets.yaml").read_text(encoding="utf-8"))["markets"][market]
    earnings_warning_days = int(cfg.get("earnings_warning_days", 7))

    candidates = run_stage2_screener(market, limit=max_candidates)
    raw_screened_count = len(candidates)
    print(f"[scan] {market} Stage 1 初篩完成：{raw_screened_count} 檔", file=sys.stderr)

    excluded_oes: List[str] = []
    if market == "TW":
        bench_df = fetch_tw_history(cfg["benchmark"], bars=bars)
        tw_snapshot = load_tw_chips_snapshot()
        excluded_oes = [r["symbol"] for r in candidates if not is_tw_listed_or_otc(r["symbol"], tw_snapshot)]
        if excluded_oes:
            candidates = [r for r in candidates if is_tw_listed_or_otc(r["symbol"], tw_snapshot)]
            print(f"[scan] 已排除興櫃／非上市櫃標的 ({len(excluded_oes)} 檔): {excluded_oes}", file=sys.stderr)
    else:
        bench_df = fetch_us_history(cfg["benchmark"], bars=bars)
        tw_snapshot = None

    def _process(row: Dict[str, Any]) -> Dict[str, Any]:
        sym = row["symbol"]
        if market == "TW":
            stock_df = fetch_tw_history(sym, bars=bars, exchange=row.get("exchange"))
            catalysts = fetch_tw_catalysts(sym, snapshot=tw_snapshot)
        else:
            stock_df = fetch_us_history(sym, bars=bars)
            catalysts = build_us_catalysts(
                sym,
                screener_row=row,
                earnings_warning_days=earnings_warning_days,
                fetch_futu_financials=False,
            )

        res = calculate_vcp_metrics(sym, stock_df, bench_df, market=market, catalysts=catalysts)
        vol_ma50 = int(round(float(stock_df["volume"].iloc[-50:].mean()))) if len(stock_df) >= 50 else 0
        return {"row": row, "result": res, "vol_ma50": vol_ma50}

    evaluated: List[Dict[str, Any]] = []
    failed_count = 0

    max_workers = 2 if market == "US" else 4
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_map = {pool.submit(_process, row): row["symbol"] for row in candidates}
        for fut in as_completed(future_map):
            sym = future_map[fut]
            try:
                item = fut.result()
                if "error" in item["result"]:
                    failed_count += 1
                    print(f"[scan] 略過 {sym}: {item['result']['error']}", file=sys.stderr)
                else:
                    evaluated.append(item)
            except Exception as exc:
                failed_count += 1
                print(f"[scan] 失敗 {sym}: {exc}", file=sys.stderr)

    if failed_count:
        print(f"[scan] 共略過/失敗 {failed_count} 檔", file=sys.stderr)

    _assign_rs_ratings(evaluated)

    scored_items: List[Dict[str, Any]] = []
    stage2_count = 0
    vcp_tight_count = 0
    earnings_warning_count = 0

    for item in evaluated:
        row = item["row"]
        res = item["result"]
        g1 = res["gate1_market"]
        g2 = res["gate2_trend_rs"]
        g3 = res.get("gate3_catalysts") or {}
        g4 = res["gate4_setup_risk"]
        meta = res["meta"]

        if g2.get("stage2_template_pass"):
            stage2_count += 1
        if (
            (
                float(g4.get("bbw_120d_percentile", 100.0)) <= 25.0
                and float(g4.get("atr_5_20_ratio", 1.0)) <= 0.75
                and float(g4.get("tightness_10d_pct", 100.0)) <= 10.0
            )
            or (g4.get("range_contracting") and g4.get("range_5d_tight"))
        ):
            vcp_tight_count += 1

        score = _score_candidate(res, market)
        pre_grade = meta["pre_filter_grade"]
        focus_grade = pre_grade
        warnings: List[str] = []
        has_earnings_warn = bool(g3.get("earnings_warning"))

        if has_earnings_warn:
            earnings_warning_count += 1
            warnings.append("EARNINGS_WARNING")
            focus_grade = _EARNINGS_DOWNGRADE.get(pre_grade, pre_grade)
            score = max(0, score - 15)

        if g1.get("benchmark_trend") == "DOWNTREND":
            warnings.append("MARKET_DOWNTREND")

        vcp_tier = _classify_vcp_tier(res, market, len(evaluated), has_earnings_warn)
        setup_status = str(g4.get("setup_status") or meta.get("setup_status") or "CONSOLIDATING")

        scored_items.append(
            {
                "symbol": row["symbol"],
                "name": row.get("name") or row["symbol"],
                "exchange": row.get("exchange") or "",
                "sector": row.get("sector"),
                "vcp_tier": vcp_tier,
                "setup_status": setup_status,
                "rs_rating": g2.get("rs_rating"),
                "focus_grade": focus_grade,
                "pre_filter_grade": pre_grade,
                "vcp_score": score,
                "warnings": warnings,
                "close_price": meta["close_price"],
                "suggested_pivot": g4["suggested_pivot"],
                "suggested_stop_loss": g4["suggested_stop_loss"],
                "tight_stop_5d_low": g4.get("tight_stop_5d_low"),
                "stop_loss_pct": g4["stop_loss_pct"],
                "dist_to_pivot_pct": g4.get("dist_to_pivot_pct"),
                "target_2r": g4.get("target_2r"),
                "target_3r": g4.get("target_3r"),
                "vol_ma50": item["vol_ma50"],
                "metrics": res,
            }
        )

    def _sort_key(x: Dict[str, Any]) -> tuple[int, int, int, int, str]:
        return (
            _TIER_PRIORITY.get(x["vcp_tier"], 0),
            _STATUS_PRIORITY.get(x["setup_status"], 0),
            _GRADE_PRIORITY.get(x["focus_grade"], 0),
            int(x["vcp_score"]),
            x["symbol"],
        )

    stage2_items = sorted(
        [x for x in scored_items if x["metrics"]["gate2_trend_rs"].get("stage2_template_pass")],
        key=_sort_key,
        reverse=True,
    )
    selected = stage2_items[:focus_max]

    if market == "US" and selected:
        us_zh_map = fetch_us_chinese_names([e["symbol"] for e in selected])
        for entry in selected:
            entry["name_zh"] = us_zh_map.get(entry["symbol"], "")
            fq = _fetch_futu_quarterly_growth(entry["symbol"])
            if fq:
                g3 = entry["metrics"]["gate3_catalysts"]
                g3["latest_quarter"] = fq
                if g3.get("source") == "TradingView":
                    g3["source"] = "TradingView+FutuCLI"
    elif market == "TW" and selected:
        for entry in selected:
            entry["name_zh"] = str((entry["metrics"].get("gate3_catalysts") or {}).get("name_zh") or "")

    for idx, entry in enumerate(selected, start=1):
        entry["rank"] = idx

    # Reorder rank key cleanly to front
    focus_list = [
        {
            "rank": e["rank"],
            "symbol": e["symbol"],
            "name": e["name"],
            "name_zh": e.get("name_zh", ""),
            "exchange": e["exchange"],
            "sector": e["sector"],
            "vcp_tier": e["vcp_tier"],
            "setup_status": e["setup_status"],
            "rs_rating": e["rs_rating"],
            "focus_grade": e["focus_grade"],
            "pre_filter_grade": e["pre_filter_grade"],
            "vcp_score": e["vcp_score"],
            "warnings": e["warnings"],
            "close_price": e["close_price"],
            "suggested_pivot": e["suggested_pivot"],
            "suggested_stop_loss": e["suggested_stop_loss"],
            "tight_stop_5d_low": e.get("tight_stop_5d_low"),
            "stop_loss_pct": e["stop_loss_pct"],
            "dist_to_pivot_pct": e.get("dist_to_pivot_pct"),
            "target_2r": e.get("target_2r"),
            "target_3r": e.get("target_3r"),
            "vol_ma50": e["vol_ma50"],
            "metrics": e["metrics"],
        }
        for e in selected
    ]

    bm_trend = (
        focus_list[0]["metrics"]["gate1_market"]["benchmark_trend"]
        if focus_list
        else (
            evaluated[0]["result"]["gate1_market"]["benchmark_trend"]
            if evaluated
            else "UNKNOWN"
        )
    )
    now = _now_taipei()
    expected_price_date, _ = market_post_close_cutoff(market)
    expected_price_ymd = expected_price_date.isoformat()
    eval_dates = [
        str(it["result"]["meta"].get("data_date") or "")
        for it in evaluated
        if it["result"]["meta"].get("data_date")
    ]
    price_latest_date = max(eval_dates) if eval_dates else None
    stale_price_count = sum(1 for d in eval_dates if d < expected_price_ymd)

    comp_warnings: List[str] = []
    if price_latest_date is None or price_latest_date < expected_price_ymd:
        comp_warnings.append("PRICE_DATA_LAGGING")
    if raw_screened_count >= 10 and failed_count / raw_screened_count > 0.25:
        comp_warnings.append("HIGH_FAILURE_RATE")

    data_completeness: Dict[str, Any] = {
        "expected_market_date": expected_price_ymd,
        "price_latest_date": price_latest_date,
        "stale_price_count": stale_price_count,
        "screened_count": raw_screened_count,
        "calculated_count": len(evaluated),
        "failed_count": failed_count,
    }
    if market == "TW":
        expected_chips_ymd, margin_expected_ready = expected_tw_chips_date()
        twse_dates = [
            str(v.get("data_date") or "")
            for v in (tw_snapshot or {}).values()
            if isinstance(v, dict) and v.get("source") == "TWSE" and v.get("data_date")
        ]
        tpex_dates = [
            str(v.get("data_date") or "")
            for v in (tw_snapshot or {}).values()
            if isinstance(v, dict) and v.get("source") == "TPEX" and v.get("data_date")
        ]
        twse_chips_date = max(twse_dates) if twse_dates else None
        tpex_chips_date = max(tpex_dates) if tpex_dates else None
        twse_eval = [
            it["result"].get("gate3_catalysts") or {}
            for it in evaluated
            if (it["result"].get("gate3_catalysts") or {}).get("source") == "TWSE"
        ]
        twse_margin_ready_count = sum(1 for g3 in twse_eval if g3.get("margin") is not None)
        if twse_chips_date is None or twse_chips_date < expected_chips_ymd:
            comp_warnings.append("TWSE_CHIPS_LAGGING")
        if tpex_chips_date is None or tpex_chips_date < expected_chips_ymd:
            comp_warnings.append("TPEX_CHIPS_LAGGING")
        if margin_expected_ready and twse_eval and twse_margin_ready_count == 0:
            comp_warnings.append("TWSE_MARGIN_PENDING")
        data_completeness.update(
            {
                "expected_chips_date": expected_chips_ymd,
                "margin_expected_ready": margin_expected_ready,
                "twse_chips_date": twse_chips_date,
                "tpex_chips_date": tpex_chips_date,
                "twse_stock_count": len(twse_eval),
                "twse_margin_ready_count": twse_margin_ready_count,
            }
        )

    data_completeness["warnings"] = comp_warnings
    data_completeness["is_complete"] = len(comp_warnings) == 0

    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "market": market,
        "benchmark_symbol": cfg["benchmark"],
        "benchmark_trend": bm_trend,
        "market_regime_warning": "BENCHMARK_DOWNTREND" if bm_trend == "DOWNTREND" else None,
        "data_completeness": data_completeness,
        "funnel_stats": {
            "screened_count": raw_screened_count,
            "excluded_oes_count": len(excluded_oes),
            "calculated_count": len(evaluated),
            "failed_count": failed_count,
            "stage2_count": stage2_count,
            "vcp_tight_count": vcp_tight_count,
            "earnings_warning_count": earnings_warning_count,
            "focus_count": len(focus_list),
        },
        "focus_list": focus_list,
    }


def _pad_cjk(text: str, width: int) -> str:
    """依東亞全形字元寬度對齊欄位並安全截斷。"""
    out: List[str] = []
    cur = 0
    for ch in str(text or ""):
        w = 2 if unicodedata.east_asian_width(ch) in ("F", "W") else 1
        if cur + w > width:
            break
        out.append(ch)
        cur += w
    return "".join(out) + (" " * max(0, width - cur))


def _print_summary(report: Dict[str, Any]) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    stats = report["funnel_stats"]
    comp = report.get("data_completeness") or {}
    print(
        f"\n=== {report['market']} 盤後海選漏斗 | 大盤 {report['benchmark_symbol']}: {report['benchmark_trend']} ==="
    )
    if comp:
        comp_state = "OK" if comp.get("is_complete") else ",".join(comp.get("warnings") or ["INCOMPLETE"])
        chips_note = (
            f" | TWSE籌碼={comp.get('twse_chips_date')} TPEx籌碼={comp.get('tpex_chips_date')}"
            f" 融資={comp.get('twse_margin_ready_count', 0)}/{comp.get('twse_stock_count', 0)}"
            if report["market"] == "TW"
            else ""
        )
        print(
            f"[資料齊全度] {comp_state} | K線最新={comp.get('price_latest_date')} "
            f"(預期={comp.get('expected_market_date')}) | 失敗={stats.get('failed_count', 0)}{chips_note}"
        )
    oes_info = f", 排除興櫃={stats.get('excluded_oes_count', 0)}" if report["market"] == "TW" else ""
    print(
        f"初篩 {stats['screened_count']} → 精算成功 {stats['calculated_count']} "
        f"(Stage2={stats['stage2_count']}{oes_info}, TightVCP={stats['vcp_tight_count']}, "
        f"EarningsWarn={stats['earnings_warning_count']}) → Focus List {stats['focus_count']} 檔\n"
    )
    header = (
        f"{'#':>2}  {'Symbol':<6} {'Name':<14} {'Tier':<4} {'Status':<13} {'Score':>5} {'RS':>3} "
        f"{'Close':>8} {'Pivot':>8} {'Dist%':>6} {'Stop%':>6} {'BBW%':>6} {'ATRr':>5} Warnings"
    )
    print(header)
    print("-" * len(header))
    for item in report["focus_list"]:
        g2 = item["metrics"]["gate2_trend_rs"]
        g4 = item["metrics"]["gate4_setup_risk"]
        rs_val = item.get("rs_rating") if item.get("rs_rating") is not None else g2.get("rs_rating")
        rs_col = f"{int(rs_val):>3}" if rs_val is not None else "  -"
        dist_val = item.get("dist_to_pivot_pct") if item.get("dist_to_pivot_pct") is not None else g4.get("dist_to_pivot_pct")
        dist_col = f"{float(dist_val):>+6.1f}" if dist_val is not None else "     -"
        tier_col = str(item.get("vcp_tier") or "-")
        status_col = str(item.get("setup_status") or g4.get("setup_status") or "-")
        warns = ",".join(item["warnings"]) or "-"
        name_col = _pad_cjk(item.get("name_zh") or item.get("name") or "-", 14)
        print(
            f"{item['rank']:>2}  {item['symbol']:<6} {name_col} {tier_col:<4} {status_col:<13} {item['vcp_score']:>5} {rs_col} "
            f"{item['close_price']:>8.2f} {item['suggested_pivot']:>8.2f} {dist_col} {item['stop_loss_pct']:>6.2f} "
            f"{g4['bbw_120d_percentile']:>6.1f} {g4['atr_5_20_ratio']:>5.2f} {warns}"
        )


def _build_vcp_candidates_export(report: Dict[str, Any]) -> Dict[str, Any]:
    """輸出與 vcp_candidates_YYYYMMDD.json 規範相容之扁平化候選摘要。"""
    candidates: List[Dict[str, Any]] = []
    for item in report.get("focus_list") or []:
        g2 = item["metrics"]["gate2_trend_rs"]
        g3 = item["metrics"].get("gate3_catalysts") or {}
        g4 = item["metrics"]["gate4_setup_risk"]
        candidates.append(
            {
                "rank": item["rank"],
                "symbol": item["symbol"],
                "name": item.get("name"),
                "name_zh": item.get("name_zh", ""),
                "vcp_tier": item.get("vcp_tier"),
                "setup_status": item.get("setup_status") or g4.get("setup_status"),
                "rs_rating": item.get("rs_rating") if item.get("rs_rating") is not None else g2.get("rs_rating"),
                "vcp_score": item["vcp_score"],
                "close_price": item["close_price"],
                "pivot_price": item["suggested_pivot"],
                "stop_loss_price": item["suggested_stop_loss"],
                "tight_stop_5d_low": g4.get("tight_stop_5d_low"),
                "stop_loss_pct": item["stop_loss_pct"],
                "dist_to_pivot_pct": g4.get("dist_to_pivot_pct"),
                "target_2r": g4.get("target_2r"),
                "target_3r": g4.get("target_3r"),
                "range_40d_pct": g4.get("range_40d_pct"),
                "range_20d_pct": g4.get("range_20d_pct"),
                "range_10d_pct": g4.get("range_10d_pct"),
                "range_5d_pct": g4.get("range_5d_pct"),
                "contraction_steps": g4.get("contraction_steps"),
                "vol_ma5_to_50_ratio": g4.get("vol_ma5_to_50_ratio"),
                "closing_range": g4.get("closing_range"),
                "institutional_10d_lots": g3.get("institutional_10d_lots"),
            }
        )
    return {
        "generated_at": report.get("generated_at"),
        "market": report.get("market"),
        "benchmark_symbol": report.get("benchmark_symbol"),
        "benchmark_trend": report.get("benchmark_trend"),
        "funnel_stats": report.get("funnel_stats"),
        "candidates": candidates,
    }


def main() -> None:
    p = argparse.ArgumentParser(description="盤後全市場 SEPA / VCP 漏斗海選")
    p.add_argument("--market", required=True, choices=["TW", "US"])
    p.add_argument("--max-candidates", type=int, default=150)
    p.add_argument("--focus-min", type=int, default=0)
    p.add_argument("--focus-max", type=int, default=15)
    p.add_argument("--bars", type=int, default=330)
    p.add_argument("--notify", action="store_true", help="海選完成後推播摘要至 Telegram")
    a = p.parse_args()

    t0 = time.time()
    report = run_scan(
        market=a.market,
        max_candidates=a.max_candidates,
        focus_min=a.focus_min,
        focus_max=a.focus_max,
        bars=a.bars,
    )

    now = _now_taipei()
    today_str = now.strftime("%Y-%m-%d")
    ymd_str = now.strftime("%Y%m%d")
    watchlist_path = ROOT / "config" / "watchlists" / f"{a.market.lower()}_focus.json"
    report_path = ROOT / "data" / "reports" / f"{a.market}_scan_{today_str}.json"
    cand_name = f"vcp_candidates_{ymd_str}.json" if a.market == "TW" else f"vcp_candidates_us_{ymd_str}.json"
    candidates_path = ROOT / "data" / cand_name
    watchlist_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    candidates_path.parent.mkdir(parents=True, exist_ok=True)

    text = json.dumps(report, ensure_ascii=False, indent=2)
    watchlist_path.write_text(text, encoding="utf-8")
    report_path.write_text(text, encoding="utf-8")
    candidates_path.write_text(
        json.dumps(_build_vcp_candidates_export(report), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    _print_summary(report)
    print(f"\n[saved] {watchlist_path}")
    print(f"[saved] {candidates_path}")
    print(f"[saved] {report_path}  ({time.time() - t0:.1f}s)")

    if a.notify:
        try:
            from adapters.telegram_notifier import TelegramNotifier, format_post_market_summary

            notifier = TelegramNotifier()
            res = notifier.send_message(format_post_market_summary(report))
            print(f"[telegram] 已發送通知 (message_id={res.get('message_ids')})")
        except Exception as exc:
            print(f"[telegram] 通知發送失敗: {exc}", file=sys.stderr)


if __name__ == "__main__":
    main()
