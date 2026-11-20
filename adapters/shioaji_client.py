"""永豐 Shioaji 台股盤中即時報價、預估量推算與 Focus List 訂閱介面（shioaji 1.7.7）。

嚴守專案鐵律：
  1. 僅限 Focus List 少數標的（預設上限 20 檔），嚴禁全市場批次掃描。
  2. 不提供 `kbars()` 未還原歷史日 K（歷史 K 棒一律由 `tv_screener.py` 還原權息提供）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

ROOT = Path(__file__).resolve().parents[1]
SESSION_MINUTES = 270.0  # 台股正規盤 09:00 ~ 13:30，共 270 分鐘


def _tw_tz() -> Any:
    try:
        return ZoneInfo("Asia/Taipei")
    except ZoneInfoNotFoundError:
        return timezone(timedelta(hours=8))


def load_dotenv(env_path: Optional[Path] = None) -> bool:
    """零相依讀取專案根目錄 `.env`，僅在環境變數未設定時填入。"""
    path = env_path or (ROOT / ".env")
    if not path.is_file():
        return False

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        if key:
            os.environ.setdefault(key, val)
    return True


def _parse_bool(value: Optional[str], default: bool = True) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def estimate_tw_full_day_volume(
    cum_vol_lots: float,
    now: Optional[datetime] = None,
    delay_minutes: int = 5,
) -> Dict[str, Any]:
    """依台股盤中累積張數（lots）推估全日成交張數與股數（shares = lots * 1000）。"""
    tz = _tw_tz()
    dt = now if now is not None else datetime.now(tz)
    dt = dt.replace(tzinfo=tz) if dt.tzinfo is None else dt.astimezone(tz)

    market_open = dt.replace(hour=9, minute=0, second=0, microsecond=0)
    elapsed = (dt - market_open).total_seconds() / 60.0
    cum_lots = float(cum_vol_lots)
    cum_shares = int(round(cum_lots * 1000.0))

    if elapsed <= 0:
        status = "PRE_MARKET"
        scale_factor = None
        est_lots = None
        est_shares = None
    elif elapsed < delay_minutes:
        status = "DELAY_WINDOW"
        scale_factor = None
        est_lots = None
        est_shares = None
    elif elapsed < SESSION_MINUTES:
        status = "INTRADAY"
        scale = SESSION_MINUTES / elapsed
        scale_factor = round(scale, 4)
        est_lots = round(cum_lots * scale, 1)
        est_shares = int(round(est_lots * 1000.0))
    else:
        status = "POST_MARKET"
        scale_factor = 1.0
        est_lots = round(cum_lots, 1)
        est_shares = int(round(cum_lots * 1000.0))

    return {
        "status": status,
        "as_of": dt.isoformat(timespec="seconds"),
        "elapsed_minutes": round(elapsed, 2),
        "cum_vol_lots": round(cum_lots, 1),
        "cum_vol_shares": cum_shares,
        "scale_factor": scale_factor,
        "estimated_vol_lots": est_lots,
        "estimated_vol_shares": est_shares,
    }


def evaluate_tw_breakout(
    symbol: str,
    last_price: float,
    cum_vol_lots: float,
    suggested_pivot: float,
    vol_ma50_shares: int,
    now: Optional[datetime] = None,
    delay_minutes: int = 5,
    vol_multiplier: float = 1.5,
) -> Dict[str, Any]:
    """檢核雙重突破條件：即時價 >= suggested_pivot 且 預估全日量 >= 50 日均量 * 1.5。"""
    est = estimate_tw_full_day_volume(cum_vol_lots, now=now, delay_minutes=delay_minutes)
    price_triggered = bool(suggested_pivot > 0 and last_price >= suggested_pivot)

    est_shares = est["estimated_vol_shares"]
    est_vol_ratio = (
        round(est_shares / vol_ma50_shares, 2)
        if est_shares is not None and vol_ma50_shares > 0
        else None
    )
    volume_triggered = bool(est_vol_ratio is not None and est_vol_ratio >= vol_multiplier)

    return {
        "symbol": symbol,
        "last_price": round(float(last_price), 2),
        "suggested_pivot": round(float(suggested_pivot), 2),
        "price_triggered": price_triggered,
        "vol_ma50_shares": int(vol_ma50_shares),
        "est_vol_ratio_50d": est_vol_ratio,
        "volume_triggered": volume_triggered,
        "triggered": price_triggered and volume_triggered,
        "volume_estimate": est,
    }


class ShioajiClient:
    """永豐 Shioaji Focus List 即時行情連線管理器。"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        simulation: Optional[bool] = None,
        ca_path: Optional[str] = None,
        ca_password: Optional[str] = None,
        person_id: Optional[str] = None,
        max_symbols: int = 20,
    ) -> None:
        self._dotenv_loaded = load_dotenv()
        self.api_key = (
            api_key
            if api_key is not None
            else (os.environ.get("SHIOAJI_API_KEY") or os.environ.get("SJ_API_KEY") or "")
        ).strip()
        self.secret_key = (
            secret_key
            if secret_key is not None
            else (os.environ.get("SHIOAJI_SECRET_KEY") or os.environ.get("SJ_SEC_KEY") or "")
        ).strip()
        if simulation is not None:
            self.simulation = simulation
        elif (os.environ.get("SHIOAJI_SIMULATION") or "").strip():
            self.simulation = _parse_bool(os.environ.get("SHIOAJI_SIMULATION"), default=True)
        elif (os.environ.get("SJ_PRODUCTION") or "").strip():
            self.simulation = not _parse_bool(os.environ.get("SJ_PRODUCTION"), default=False)
        else:
            self.simulation = True
        self.ca_path = (
            ca_path
            if ca_path is not None
            else (os.environ.get("SHIOAJI_CA_PATH") or os.environ.get("SJ_CA_PATH") or "")
        ).strip()
        self.ca_password = (
            ca_password
            if ca_password is not None
            else (os.environ.get("SHIOAJI_CA_PASSWORD") or os.environ.get("SJ_CA_PASSWD") or "")
        ).strip()
        self.person_id = (
            person_id
            if person_id is not None
            else (os.environ.get("SHIOAJI_PERSON_ID") or os.environ.get("SJ_PERSON_ID") or "")
        ).strip() or None
        self.max_symbols = max_symbols
        self.api: Any = None
        self._sj: Any = None
        self._subscribed: Dict[str, Any] = {}

    def credentials_status(self) -> Dict[str, Any]:
        """回傳憑證設定狀態布林值（絕不輸出金鑰內容）。"""
        return {
            "has_api_key": bool(self.api_key),
            "has_secret_key": bool(self.secret_key),
            "simulation": self.simulation,
            "has_ca_config": bool(self.ca_path and self.ca_password),
            "dotenv_exists": (ROOT / ".env").is_file(),
        }

    def connect(self, activate_ca: bool = False) -> None:
        if not self.api_key or not self.secret_key:
            raise ValueError(
                "尚未設定 SJ_API_KEY / SJ_SEC_KEY（或 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY），請複製 .env.example 為 .env 並填入永豐 API 金鑰"
            )

        log_path = ROOT / "data" / "cache" / "shioaji.log"
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            os.environ.setdefault("SJ_LOG_PATH", str(log_path))
        except OSError:
            pass

        import shioaji as sj

        self._sj = sj
        self.api = sj.Shioaji(simulation=self.simulation)
        self.api.login(
            api_key=self.api_key,
            secret_key=self.secret_key,
            subscribe_trade=False,
        )

        if activate_ca:
            if not self.ca_path or not self.ca_password or not Path(self.ca_path).is_file():
                raise ValueError("啟用下單憑證失敗：請確認 SHIOAJI_CA_PATH 與 SHIOAJI_CA_PASSWORD 設定正確")
            self.api.activate_ca(
                ca_path=self.ca_path,
                ca_passwd=self.ca_password,
                person_id=self.person_id,
            )

    def close(self) -> None:
        if self.api is None:
            return
        try:
            self.unsubscribe_all()
        finally:
            try:
                self.api.logout()
            except Exception:
                pass
            self.api = None

    def __enter__(self) -> "ShioajiClient":
        self.connect()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def _enforce_focus_limit(self, symbols: Sequence[str]) -> List[str]:
        seen = set()
        codes: List[str] = []
        for s in symbols:
            code = str(s).split(".")[0].strip()
            if code and code not in seen:
                seen.add(code)
                codes.append(code)
        if len(codes) > self.max_symbols:
            raise ValueError(
                f"禁止使用 Shioaji 批次查詢超過 {self.max_symbols} 檔（目前 {len(codes)} 檔），請僅傳入 Focus List 標的"
            )
        return codes

    @staticmethod
    def _assert_not_oes(code: str, contract: Any, allow_oes: bool) -> Any:
        if not allow_oes and str(getattr(contract, "exchange", "")).upper() == "OES":
            raise ValueError(f"已排除興櫃標的 (OES): {code}")
        return contract

    def resolve_contract(self, symbol: str, allow_oes: bool = False) -> Any:
        if self.api is None:
            raise RuntimeError("Shioaji 尚未連線")
        code = str(symbol).split(".")[0].strip()
        stocks = self.api.Contracts.Stocks

        for container_name, prefixes in (("TSE", ("", "TSE")), ("OTC", ("", "OTC"))):
            container = getattr(stocks, container_name, None)
            if container is None:
                continue
            for pfx in prefixes:
                try:
                    c = container[f"{pfx}{code}"]
                    if c is not None:
                        return self._assert_not_oes(code, c, allow_oes)
                except Exception:
                    continue

        try:
            contract = stocks[code]
            if contract is not None:
                return self._assert_not_oes(code, contract, allow_oes)
        except ValueError:
            raise
        except Exception:
            pass

        raise KeyError(f"Shioaji 找不到上市櫃台股合約: {code}")

    def get_usage(self) -> Dict[str, Any]:
        if self.api is None:
            raise RuntimeError("Shioaji 尚未連線")
        u = self.api.usage()

        def _get(field: str) -> Any:
            if isinstance(u, dict):
                return u.get(field)
            return getattr(u, field, None)

        return {
            "connections": _get("connections"),
            "bytes": _get("bytes"),
            "limit_bytes": _get("limit_bytes"),
            "remaining_bytes": _get("remaining_bytes"),
        }

    def get_snapshots(
        self,
        symbols: Sequence[str],
        delay_minutes: int = 5,
        now: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        if self.api is None:
            raise RuntimeError("Shioaji 尚未連線")
        codes = self._enforce_focus_limit(symbols)
        contracts = []
        for code in codes:
            try:
                contracts.append(self.resolve_contract(code))
            except (KeyError, ValueError) as exc:
                print(f"[shioaji_client] {exc}", file=sys.stderr)

        if not contracts:
            return []

        snaps = self.api.snapshots(contracts)
        out: List[Dict[str, Any]] = []
        for snap in snaps:
            total_lots = int(getattr(snap, "total_volume", 0) or 0)
            est = estimate_tw_full_day_volume(total_lots, now=now, delay_minutes=delay_minutes)
            out.append(
                {
                    "symbol": getattr(snap, "code", ""),
                    "exchange": str(getattr(snap, "exchange", "")),
                    "close": float(getattr(snap, "close", 0.0) or 0.0),
                    "open": float(getattr(snap, "open", 0.0) or 0.0),
                    "high": float(getattr(snap, "high", 0.0) or 0.0),
                    "low": float(getattr(snap, "low", 0.0) or 0.0),
                    "change_price": float(getattr(snap, "change_price", 0.0) or 0.0),
                    "change_rate": float(getattr(snap, "change_rate", 0.0) or 0.0),
                    "buy_price": float(getattr(snap, "buy_price", 0.0) or 0.0),
                    "sell_price": float(getattr(snap, "sell_price", 0.0) or 0.0),
                    "volume_lots": int(getattr(snap, "volume", 0) or 0),
                    "total_volume_lots": total_lots,
                    "total_volume_shares": total_lots * 1000,
                    "yesterday_volume_lots": int(getattr(snap, "yesterday_volume", 0) or 0),
                    "total_amount": int(getattr(snap, "total_amount", 0) or 0),
                    "volume_estimate": est,
                }
            )
        return out

    def subscribe_ticks(
        self,
        symbols: Sequence[str],
        on_tick: Callable[[Dict[str, Any]], None],
        delay_minutes: int = 5,
    ) -> List[str]:
        if self.api is None or self._sj is None:
            raise RuntimeError("Shioaji 尚未連線")
        codes = self._enforce_focus_limit(symbols)

        def _handler(exchange: Any, tick: Any) -> None:
            if getattr(tick, "simtrade", 0) == 1 or getattr(tick, "intraday_odd", 0) == 1:
                return
            total_lots = int(getattr(tick, "total_volume", 0) or 0)
            tick_dt = getattr(tick, "datetime", None)
            now_dt = tick_dt if isinstance(tick_dt, datetime) else None
            payload = {
                "symbol": getattr(tick, "code", ""),
                "exchange": str(exchange),
                "datetime": str(tick_dt or ""),
                "close": float(getattr(tick, "close", 0.0) or 0.0),
                "volume_lots": int(getattr(tick, "volume", 0) or 0),
                "total_volume_lots": total_lots,
                "total_volume_shares": total_lots * 1000,
                "pct_chg": float(getattr(tick, "pct_chg", 0.0) or 0.0),
                "volume_estimate": estimate_tw_full_day_volume(
                    total_lots, now=now_dt, delay_minutes=delay_minutes
                ),
            }
            on_tick(payload)

        self.api.set_on_tick_stk_v1_callback(_handler)
        subscribed_codes: List[str] = []
        for code in codes:
            try:
                contract = self.resolve_contract(code)
            except (KeyError, ValueError) as exc:
                print(f"[shioaji_client] {exc}", file=sys.stderr)
                continue
            self.api.subscribe(
                contract,
                quote_type=self._sj.QuoteType.Tick,
                intraday_odd=False,
                version=self._sj.QuoteVersion.v1,
            )
            self._subscribed[code] = contract
            subscribed_codes.append(code)
        return subscribed_codes

    def unsubscribe_all(self) -> None:
        if self.api is None or self._sj is None or not self._subscribed:
            self._subscribed.clear()
            return
        for contract in list(self._subscribed.values()):
            try:
                self.api.unsubscribe(
                    contract,
                    quote_type=self._sj.QuoteType.Tick,
                    intraday_odd=False,
                    version=self._sj.QuoteVersion.v1,
                )
            except Exception:
                pass
        self._subscribed.clear()


def _run_selftest() -> None:
    tz = _tw_tz()
    pre = estimate_tw_full_day_volume(100, now=datetime(2026, 11, 20, 8, 50, tzinfo=tz))
    assert pre["status"] == "PRE_MARKET" and pre["estimated_vol_shares"] is None, pre

    delay = estimate_tw_full_day_volume(500, now=datetime(2026, 11, 20, 9, 3, tzinfo=tz), delay_minutes=5)
    assert delay["status"] == "DELAY_WINDOW" and delay["estimated_vol_shares"] is None, delay

    mid = estimate_tw_full_day_volume(1000, now=datetime(2026, 11, 20, 10, 30, tzinfo=tz), delay_minutes=5)
    assert mid["status"] == "INTRADAY" and mid["scale_factor"] == 3.0, mid
    assert mid["estimated_vol_lots"] == 3000.0 and mid["estimated_vol_shares"] == 3_000_000, mid

    post = estimate_tw_full_day_volume(2500, now=datetime(2026, 11, 20, 13, 45, tzinfo=tz))
    assert post["status"] == "POST_MARKET" and post["scale_factor"] == 1.0 and post["estimated_vol_shares"] == 2_500_000, post

    hit = evaluate_tw_breakout(
        symbol="6199",
        last_price=173.0,
        cum_vol_lots=3500,
        suggested_pivot=172.84,
        vol_ma50_shares=6_961_529,
        now=datetime(2026, 11, 20, 10, 30, tzinfo=tz),
    )
    assert hit["price_triggered"] is True and hit["volume_triggered"] is True and hit["triggered"] is True, hit
    assert hit["est_vol_ratio_50d"] == 1.51, hit

    miss = evaluate_tw_breakout(
        symbol="6199",
        last_price=173.0,
        cum_vol_lots=2000,
        suggested_pivot=172.84,
        vol_ma50_shares=6_961_529,
        now=datetime(2026, 11, 20, 10, 30, tzinfo=tz),
    )
    assert miss["price_triggered"] is True and miss["volume_triggered"] is False and miss["triggered"] is False, miss

    client = ShioajiClient()
    try:
        client._enforce_focus_limit([str(i) for i in range(1000, 1021)])
        raise AssertionError("21 檔應觸發 Focus List 上限錯誤")
    except ValueError:
        pass

    orig_sim = os.environ.pop("SHIOAJI_SIMULATION", None)
    orig_prod = os.environ.get("SJ_PRODUCTION")
    try:
        os.environ["SJ_PRODUCTION"] = "true"
        assert ShioajiClient().simulation is False, "SJ_PRODUCTION=true 應對應 simulation=False"
    finally:
        if orig_sim is not None:
            os.environ["SHIOAJI_SIMULATION"] = orig_sim
        if orig_prod is not None:
            os.environ["SJ_PRODUCTION"] = orig_prod
        else:
            os.environ.pop("SJ_PRODUCTION", None)

    dummy_oes = type("_DummyContract", (), {"exchange": "OES"})()
    dummy_tse = type("_DummyContract", (), {"exchange": "TSE"})()
    try:
        ShioajiClient._assert_not_oes("6827", dummy_oes, allow_oes=False)
        raise AssertionError("OES 合約應被排除")
    except ValueError:
        pass
    assert ShioajiClient._assert_not_oes("6827", dummy_oes, allow_oes=True) is dummy_oes
    assert ShioajiClient._assert_not_oes("2330", dummy_tse, allow_oes=False) is dummy_tse

    print("PASS: estimate_tw_full_day_volume (PRE_MARKET / DELAY_WINDOW / INTRADAY 3.0x / POST_MARKET)")
    print("PASS: evaluate_tw_breakout (dual-trigger True & False cases)")
    print("PASS: Focus List guard (>20 symbols rejected)")
    print("PASS: SJ_PRODUCTION=true -> simulation=False")
    print("PASS: OES emerging-market contract guard")
    print("Credential status:", json.dumps(client.credentials_status(), ensure_ascii=False))


def _load_focus_meta(delay_default: int = 5) -> tuple[List[str], Dict[str, Dict[str, Any]], int]:
    delay = delay_default
    cfg_path = ROOT / "config" / "markets.yaml"
    if cfg_path.is_file():
        import yaml

        tw_cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))["markets"]["TW"]
        delay = int(tw_cfg.get("intraday_volume_estimate_delay_minutes", delay_default))

    focus_path = ROOT / "config" / "watchlists" / "tw_focus.json"
    if not focus_path.is_file():
        raise FileNotFoundError(f"找不到 {focus_path}，請先執行 run_post_market_scan --market TW")

    data = json.loads(focus_path.read_text(encoding="utf-8"))
    focus_items = data.get("focus_list") or []
    symbols = [item["symbol"] for item in focus_items]
    meta = {
        item["symbol"]: {
            "suggested_pivot": float(item.get("suggested_pivot") or 0.0),
            "vol_ma50": int(item.get("vol_ma50") or 0),
            "focus_grade": item.get("focus_grade"),
        }
        for item in focus_items
    }
    return symbols, meta, delay


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description="永豐 Shioaji Focus List 連線、快照與即時 Tick 驗證工具")
    p.add_argument("--selftest", action="store_true", help="執行離線單元自測並顯示憑證設定狀態")
    p.add_argument("--symbols", help="逗號分隔台股代號，例如 2330,6199")
    p.add_argument("--from-focus", action="store_true", help="載入 config/watchlists/tw_focus.json 標的")
    p.add_argument("--stream", type=int, default=0, help="訂閱即時 Tick 測試秒數（0 表示僅查快照）")
    p.add_argument("--simulation", action="store_true", help="強制使用模擬環境")
    p.add_argument("--live", action="store_true", help="強制使用正式行情環境")
    a = p.parse_args()

    if a.selftest:
        _run_selftest()
        return

    sim_override: Optional[bool] = None
    if a.simulation:
        sim_override = True
    elif a.live:
        sim_override = False

    focus_meta: Dict[str, Dict[str, Any]] = {}
    delay_minutes = 5
    if a.from_focus:
        symbols, focus_meta, delay_minutes = _load_focus_meta()
    elif a.symbols:
        symbols = [s.strip() for s in a.symbols.split(",") if s.strip()]
    else:
        p.error("請指定 --selftest、--from-focus 或 --symbols")
        return

    client = ShioajiClient(simulation=sim_override)
    with client:
        usage = client.get_usage()
        print("Usage:", json.dumps(usage, ensure_ascii=False))

        snaps = client.get_snapshots(symbols, delay_minutes=delay_minutes)
        for snap in snaps:
            sym = snap["symbol"]
            meta = focus_meta.get(sym)
            if meta and meta["suggested_pivot"] > 0:
                ev = evaluate_tw_breakout(
                    symbol=sym,
                    last_price=snap["close"],
                    cum_vol_lots=snap["total_volume_lots"],
                    suggested_pivot=meta["suggested_pivot"],
                    vol_ma50_shares=meta["vol_ma50"],
                    delay_minutes=delay_minutes,
                )
                snap["breakout_eval"] = {
                    "focus_grade": meta["focus_grade"],
                    "suggested_pivot": ev["suggested_pivot"],
                    "est_vol_ratio_50d": ev["est_vol_ratio_50d"],
                    "triggered": ev["triggered"],
                }
        print(json.dumps(snaps, ensure_ascii=False, indent=2))

        if a.stream > 0:
            subscribed = client.subscribe_ticks(
                symbols,
                on_tick=lambda t: print("[TICK]", json.dumps(t, ensure_ascii=False)),
                delay_minutes=delay_minutes,
            )
            print(f"[stream] 已訂閱 {len(subscribed)} 檔 ({subscribed})，監聽 {a.stream} 秒...")
            time.sleep(a.stream)


if __name__ == "__main__":
    main()
