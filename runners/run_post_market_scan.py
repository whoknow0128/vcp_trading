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

from adapters.futu_client import (  # noqa: E402
    _fetch_futu_quarterly_growth,
    build_us_catalysts,
    fetch_us_chinese_names,
    fetch_us_history,
)
from adapters.tv_screener import fetch_tw_history, run_stage2_screener  # noqa: E402
from adapters.tw_chips_fetcher import fetch_tw_catalysts, is_tw_listed_or_otc, load_tw_chips_snapshot  # noqa: E402
from core.calc_vcp_metrics import calculate_vcp_metrics  # noqa: E402

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


def _score_candidate(result: Dict[str, Any], market: str) -> int:
    g2 = result["gate2_trend_rs"]
    g3 = result.get("gate3_catalysts") or {}
    g4 = result["gate4_setup_risk"]

    score = 0
    if g2.get("stage2_template_pass"):
        score += 30
    if g2.get("rs_line_52w_high"):
        score += 15
    if g2.get("rs_above_ma50"):
        score += 8

    bbw_pct = float(g4.get("bbw_120d_percentile", 100.0))
    if bbw_pct <= 25.0:
        score += 15
    elif bbw_pct <= 40.0:
        score += 6

    atr_ratio = float(g4.get("atr_5_20_ratio", 1.0))
    if atr_ratio <= 0.75:
        score += 12
    elif atr_ratio <= 0.90:
        score += 5

    tight = float(g4.get("tightness_10d_pct", 100.0))
    if tight <= 10.0:
        score += 8
    elif tight <= 15.0:
        score += 3

    if g4.get("is_vdu_3d") or g4.get("pocket_pivot_in_5d"):
        score += 8
    if g4.get("price_above_bb_mid"):
        score += 4

    if int(g4.get("distribution_days_10d", 0)) >= 3:
        score -= 15
    if float(g4.get("dist_from_10ma_in_atr", 0.0)) > 3.5:
        score -= 10

    if market == "TW":
        inst = g3.get("institutional_5d_lots") or g3.get("institutional_1d_lots") or {}
        if (inst.get("trust") or 0) > 0 or (inst.get("foreign") or 0) > 0:
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
    max_candidates: int = 60,
    focus_min: int = 5,
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

    with ThreadPoolExecutor(max_workers=4) as pool:
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
            float(g4.get("bbw_120d_percentile", 100.0)) <= 25.0
            and float(g4.get("atr_5_20_ratio", 1.0)) <= 0.75
            and float(g4.get("tightness_10d_pct", 100.0)) <= 10.0
        ):
            vcp_tight_count += 1

        score = _score_candidate(res, market)
        pre_grade = meta["pre_filter_grade"]
        focus_grade = pre_grade
        warnings: List[str] = []

        if g3.get("earnings_warning"):
            earnings_warning_count += 1
            warnings.append("EARNINGS_WARNING")
            focus_grade = _EARNINGS_DOWNGRADE.get(pre_grade, pre_grade)
            score = max(0, score - 15)

        if g1.get("benchmark_trend") == "DOWNTREND":
            warnings.append("MARKET_DOWNTREND")

        scored_items.append(
            {
                "symbol": row["symbol"],
                "name": row.get("name") or row["symbol"],
                "exchange": row.get("exchange") or "",
                "sector": row.get("sector"),
                "focus_grade": focus_grade,
                "pre_filter_grade": pre_grade,
                "vcp_score": score,
                "warnings": warnings,
                "close_price": meta["close_price"],
                "suggested_pivot": g4["suggested_pivot"],
                "suggested_stop_loss": g4["suggested_stop_loss"],
                "stop_loss_pct": g4["stop_loss_pct"],
                "vol_ma50": item["vol_ma50"],
                "metrics": res,
            }
        )

    def _sort_key(x: Dict[str, Any]) -> tuple[int, int, str]:
        return (_GRADE_PRIORITY.get(x["focus_grade"], 0), int(x["vcp_score"]), x["symbol"])

    stage2_items = sorted(
        [x for x in scored_items if x["metrics"]["gate2_trend_rs"].get("stage2_template_pass")],
        key=_sort_key,
        reverse=True,
    )
    other_items = sorted(
        [x for x in scored_items if not x["metrics"]["gate2_trend_rs"].get("stage2_template_pass")],
        key=_sort_key,
        reverse=True,
    )

    if len(stage2_items) >= focus_min:
        selected = stage2_items[:focus_max]
    else:
        need = max(0, focus_min - len(stage2_items))
        selected = (stage2_items + other_items[:need])[:focus_max]

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
            "focus_grade": e["focus_grade"],
            "pre_filter_grade": e["pre_filter_grade"],
            "vcp_score": e["vcp_score"],
            "warnings": e["warnings"],
            "close_price": e["close_price"],
            "suggested_pivot": e["suggested_pivot"],
            "suggested_stop_loss": e["suggested_stop_loss"],
            "stop_loss_pct": e["stop_loss_pct"],
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

    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "market": market,
        "benchmark_symbol": cfg["benchmark"],
        "benchmark_trend": bm_trend,
        "market_regime_warning": "BENCHMARK_DOWNTREND" if bm_trend == "DOWNTREND" else None,
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
    print(
        f"\n=== {report['market']} 盤後海選漏斗 | 大盤 {report['benchmark_symbol']}: {report['benchmark_trend']} ==="
    )
    oes_info = f", 排除興櫃={stats.get('excluded_oes_count', 0)}" if report["market"] == "TW" else ""
    print(
        f"初篩 {stats['screened_count']} → 精算成功 {stats['calculated_count']} "
        f"(Stage2={stats['stage2_count']}{oes_info}, TightVCP={stats['vcp_tight_count']}, "
        f"EarningsWarn={stats['earnings_warning_count']}) → Focus List {stats['focus_count']} 檔\n"
    )
    header = (
        f"{'#':>2}  {'Symbol':<6} {'Name':<14} {'Grade':<19} {'Score':>5} {'Close':>8} "
        f"{'Pivot':>8} {'Stop%':>6} {'BBW%':>6} {'ATRr':>5} {'RS52H':<5} Warnings"
    )
    print(header)
    print("-" * len(header))
    for item in report["focus_list"]:
        g2 = item["metrics"]["gate2_trend_rs"]
        g4 = item["metrics"]["gate4_setup_risk"]
        rs52 = "YES" if g2.get("rs_line_52w_high") else "no"
        warns = ",".join(item["warnings"]) or "-"
        name_col = _pad_cjk(item.get("name_zh") or item.get("name") or "-", 14)
        print(
            f"{item['rank']:>2}  {item['symbol']:<6} {name_col} {item['focus_grade']:<19} {item['vcp_score']:>5} "
            f"{item['close_price']:>8.2f} {item['suggested_pivot']:>8.2f} {item['stop_loss_pct']:>6.2f} "
            f"{g4['bbw_120d_percentile']:>6.1f} {g4['atr_5_20_ratio']:>5.2f} {rs52:<5} {warns}"
        )


def main() -> None:
    p = argparse.ArgumentParser(description="盤後全市場 SEPA / VCP 漏斗海選")
    p.add_argument("--market", required=True, choices=["TW", "US"])
    p.add_argument("--max-candidates", type=int, default=60)
    p.add_argument("--focus-min", type=int, default=5)
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

    today_str = _now_taipei().strftime("%Y-%m-%d")
    watchlist_path = ROOT / "config" / "watchlists" / f"{a.market.lower()}_focus.json"
    report_path = ROOT / "data" / "reports" / f"{a.market}_scan_{today_str}.json"
    watchlist_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    text = json.dumps(report, ensure_ascii=False, indent=2)
    watchlist_path.write_text(text, encoding="utf-8")
    report_path.write_text(text, encoding="utf-8")

    _print_summary(report)
    print(f"\n[saved] {watchlist_path}")
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
