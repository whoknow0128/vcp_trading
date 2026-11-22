"""模式 A：單股深度健檢。  python -m runners.run_single_stock --symbol NVDA --market US"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import yaml  # noqa: E402

from adapters.futu_client import build_us_catalysts, fetch_us_history  # noqa: E402
from adapters.tv_screener import fetch_tw_history  # noqa: E402
from adapters.tw_chips_fetcher import fetch_tw_catalysts  # noqa: E402
from core.calc_vcp_metrics import calculate_vcp_metrics  # noqa: E402


def run(symbol: str, market: str, bars: int = 330, include_catalysts: bool = True) -> dict:
    market = market.upper()
    cfg = yaml.safe_load((ROOT / "config" / "markets.yaml").read_text(encoding="utf-8"))["markets"][market]
    fetch = fetch_tw_history if market == "TW" else fetch_us_history
    stock = fetch(symbol, bars)
    bench = fetch(cfg["benchmark"], bars)

    catalysts: Optional[Dict[str, Any]] = None
    if include_catalysts:
        try:
            if market == "TW":
                catalysts = fetch_tw_catalysts(symbol)
            else:
                catalysts = build_us_catalysts(
                    symbol,
                    earnings_warning_days=int(cfg.get("earnings_warning_days", 7)),
                    fetch_futu_financials=True,
                )
        except Exception as exc:
            print(f"[run_single_stock] 第 3 關催化劑抓取失敗 ({exc})", file=sys.stderr)

    result = calculate_vcp_metrics(symbol, stock, bench, market=market, catalysts=catalysts)
    return result


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--symbol", required=True)
    p.add_argument("--market", required=True, choices=["TW", "US"])
    p.add_argument("--bars", type=int, default=330)
    p.add_argument("--no-catalysts", action="store_true", help="略過第 3 關基本面／籌碼抓取")
    a = p.parse_args()

    t0 = time.time()
    result = run(a.symbol, a.market, a.bars, include_catalysts=not a.no_catalysts)
    out_dir = ROOT / "data" / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{a.market}_{a.symbol}.json"
    text = json.dumps(result, ensure_ascii=False, indent=2)
    out.write_text(text, encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)
    print(f"\n[saved] {out}  ({time.time() - t0:.1f}s)", file=sys.stderr)


if __name__ == "__main__":
    main()
