"""Telegram Bot API 推播介面（零外部套件相依，支援多人／多群組推播與群組自動綁定）。

環境變數支援：`TG_BOT_TOKEN` / `TG_CHAT_ID`（逗號分隔多聊天室，亦相容 `VITE_TG_*`）。
"""
from __future__ import annotations

import argparse
import html
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .shioaji_client import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
_GROUP_TYPES = ("group", "supergroup", "channel")


def _ssl_context() -> ssl.SSLContext:
    return ssl.create_default_context()


def _split_text(text: str, max_len: int = 3900) -> List[str]:
    """依換行切分長訊息，確保每段不超過 Telegram 4096 字元限制。"""
    if len(text) <= max_len:
        return [text]

    chunks: List[str] = []
    current_lines: List[str] = []
    current_len = 0

    for line in text.splitlines():
        add_len = len(line) + (1 if current_lines else 0)
        if current_len + add_len > max_len:
            if current_lines:
                chunks.append("\n".join(current_lines))
                current_lines = []
                current_len = 0
            while len(line) > max_len:
                chunks.append(line[:max_len])
                line = line[max_len:]
            if line:
                current_lines = [line]
                current_len = len(line)
        else:
            current_lines.append(line)
            current_len += add_len

    if current_lines:
        chunks.append("\n".join(current_lines))
    return chunks or [""]


def _extract_latest_group_chat(updates: List[Dict[str, Any]]) -> Optional[Dict[str, str]]:
    """從 Telegram getUpdates 清單由新到舊尋找最新的群組／頻道事件。"""
    for upd in reversed(updates):
        if not isinstance(upd, dict):
            continue

        mcm = upd.get("my_chat_member")
        if isinstance(mcm, dict):
            chat = mcm.get("chat") or {}
            ctype = str(chat.get("type") or "")
            new_status = str((mcm.get("new_chat_member") or {}).get("status") or "")
            if ctype in _GROUP_TYPES and chat.get("id") is not None and new_status not in ("left", "kicked"):
                return {
                    "chat_id": str(chat["id"]),
                    "type": ctype,
                    "title": str(chat.get("title") or ""),
                }

        for key in ("channel_post", "message", "edited_message"):
            msg = upd.get(key)
            if isinstance(msg, dict):
                chat = msg.get("chat") or {}
                ctype = str(chat.get("type") or "")
                if ctype in _GROUP_TYPES and chat.get("id") is not None:
                    return {
                        "chat_id": str(chat["id"]),
                        "type": ctype,
                        "title": str(chat.get("title") or ""),
                    }
    return None


def update_env_chat_id(
    new_chat_id: str,
    env_path: Optional[Path] = None,
    keep_existing: bool = False,
) -> int:
    """更新 `.env` 內的 `TG_CHAT_ID`（不輸出敏感 ID），回傳最終設定的聊天室數量。"""
    path = env_path or (ROOT / ".env")
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []

    existing_raw = ""
    for line in lines:
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, v = s.split("=", 1)
            if k.strip() == "TG_CHAT_ID":
                existing_raw = v.strip().strip('"').strip("'")
                break

    ids: List[str] = []
    if keep_existing and existing_raw:
        for cid in existing_raw.split(","):
            c = cid.strip()
            if c and c not in ids:
                ids.append(c)

    target = str(new_chat_id).strip()
    if target and target not in ids:
        ids.append(target)

    merged = ",".join(ids)
    out_lines: List[str] = []
    replaced = False
    for line in lines:
        s = line.strip()
        if s and not s.startswith("#") and "=" in s and s.split("=", 1)[0].strip() == "TG_CHAT_ID":
            out_lines.append(f"TG_CHAT_ID={merged}")
            replaced = True
        else:
            out_lines.append(line)
    if not replaced:
        out_lines.append(f"TG_CHAT_ID={merged}")

    path.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    os.environ["TG_CHAT_ID"] = merged
    return len(ids)


class TelegramNotifier:
    """Telegram Bot API 通知發送器（支援多聊天室，且嚴禁洩漏 bot_token）。"""

    def __init__(
        self,
        bot_token: Optional[str] = None,
        chat_id: Optional[str] = None,
    ) -> None:
        load_dotenv()
        self.bot_token = (
            bot_token
            if bot_token is not None
            else (os.environ.get("TG_BOT_TOKEN") or os.environ.get("VITE_TG_BOT_TOKEN") or "")
        ).strip()
        self.chat_id = (
            chat_id
            if chat_id is not None
            else (os.environ.get("TG_CHAT_ID") or os.environ.get("VITE_TG_CHAT_ID") or "")
        ).strip()
        self.chat_ids: List[str] = [c.strip() for c in self.chat_id.split(",") if c.strip()]

    def is_configured(self) -> bool:
        return bool(self.bot_token and self.chat_ids)

    def status(self) -> Dict[str, Any]:
        return {
            "has_bot_token": bool(self.bot_token),
            "has_chat_id": bool(self.chat_ids),
            "chat_count": len(self.chat_ids),
            "dotenv_exists": (ROOT / ".env").is_file(),
        }

    def _request_json(
        self,
        method_name: str,
        payload: Optional[Dict[str, Any]] = None,
        query: str = "",
        timeout: int = 15,
    ) -> Dict[str, Any]:
        if not self.bot_token:
            raise ValueError("尚未設定 TG_BOT_TOKEN，請於 .env 填入 Telegram Bot Token")

        url = f"https://api.telegram.org/bot{self.bot_token}/{method_name}{query}"
        if payload is not None:
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
        else:
            req = urllib.request.Request(url, method="GET")

        try:
            with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
                res = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            err_detail = ""
            try:
                err_json = json.loads(exc.read().decode("utf-8"))
                err_detail = str(err_json.get("description") or "")
            except Exception:
                pass
            raise RuntimeError(
                f"Telegram API HTTP {exc.code}" + (f": {err_detail}" if err_detail else "")
            ) from None
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Telegram 連線失敗: {exc.reason}") from None

        if not res.get("ok"):
            raise RuntimeError(f"Telegram API 回應失敗: {res.get('description') or 'unknown error'}")
        return res

    def discover_latest_group_chat(self, timeout: int = 15) -> Optional[Dict[str, str]]:
        """查詢 Bot 收到的最新群組／頻道事件。"""
        query = "?allowed_updates=%5B%22message%22%2C%22edited_message%22%2C%22channel_post%22%2C%22my_chat_member%22%5D"
        res = self._request_json("getUpdates", payload=None, query=query, timeout=timeout)
        return _extract_latest_group_chat(res.get("result") or [])

    def send_message(
        self,
        text: str,
        parse_mode: Optional[str] = "HTML",
        disable_web_page_preview: bool = True,
        timeout: int = 15,
        target_chat_ids: Optional[Sequence[str]] = None,
    ) -> Dict[str, Any]:
        targets = [
            str(c).strip()
            for c in (target_chat_ids if target_chat_ids is not None else self.chat_ids)
            if str(c).strip()
        ]
        if not self.bot_token or not targets:
            raise ValueError("尚未設定 TG_BOT_TOKEN / TG_CHAT_ID，請於 .env 填入 Telegram 通知設定")

        chunks = _split_text(text)
        message_ids: List[int] = []

        for cid in targets:
            for chunk in chunks:
                body: Dict[str, Any] = {
                    "chat_id": cid,
                    "text": chunk,
                    "disable_web_page_preview": disable_web_page_preview,
                }
                if parse_mode:
                    body["parse_mode"] = parse_mode

                res = self._request_json("sendMessage", payload=body, timeout=timeout)
                msg_id = (res.get("result") or {}).get("message_id")
                if msg_id is not None:
                    message_ids.append(int(msg_id))

        return {"ok": True, "message_ids": message_ids, "chunks": len(chunks), "targets": len(targets)}


def _format_gate3_note(market: str, g3: Dict[str, Any]) -> str:
    if not g3:
        return ""
    if market == "TW":
        parts: List[str] = []
        if g3.get("institutional_10d_lots"):
            inst = g3["institutional_10d_lots"]
            label = "10D"
        elif g3.get("institutional_5d_lots"):
            inst = g3["institutional_5d_lots"]
            label = "5D"
        else:
            inst = g3.get("institutional_1d_lots")
            label = "1D"
        if inst:
            parts.append(f"{label}投信{inst.get('trust', 0):+d}/外資{inst.get('foreign', 0):+d}張")
        rev_yoy = (g3.get("monthly_revenue") or {}).get("yoy_pct")
        if rev_yoy is not None:
            parts.append(f"營收YoY {float(rev_yoy):+.1f}%")
        return " | ".join(parts)

    parts = []
    if g3.get("earnings_warning"):
        parts.append("⚠️財報<=7日")
    elif g3.get("trading_days_to_earnings") is not None:
        parts.append(f"距財報{g3['trading_days_to_earnings']}日")
    if g3.get("eps_yoy_fq_pct") is not None:
        parts.append(f"EPS YoY {float(g3['eps_yoy_fq_pct']):+.1f}%")
    return " | ".join(parts)


def _clean_symbol(symbol: str) -> str:
    """去除交易所後綴（如 .TW / .TWO），保留乾淨股票代號。"""
    return str(symbol or "").split(".")[0].strip()


def _yahoo_chart_url(symbol: str, market: str, exchange: str = "") -> str:
    """組出 Yahoo 奇摩股市技術分析連結（台股上櫃用 .TWO、上市用 .TW、美股用原代號）。"""
    sym = _clean_symbol(symbol)
    if str(market or "").upper() == "TW":
        ex = str(exchange or "").strip().upper()
        suffix = ".TWO" if ex in ("TPEX", "OTC", "TWO") else ".TW"
        ticker = f"{sym}{suffix}"
    else:
        ticker = sym
    return f"https://tw.stock.yahoo.com/quote/{urllib.parse.quote(ticker)}/technical-analysis"


def _wantgoo_chart_url(symbol: str) -> str:
    """組出玩股網（WantGoo）台股技術線圖連結。"""
    sym = _clean_symbol(symbol)
    return f"https://www.wantgoo.com/stock/{urllib.parse.quote(sym)}/technical-chart"


def _format_symbol_links(raw_sym: str, title_label: str, market: str, exchange: str = "") -> str:
    """組合 Telegram HTML 標的連結（標題連 Yahoo 股市技術分析；台股另附玩股網 K 線）。"""
    yahoo_url = html.escape(_yahoo_chart_url(raw_sym, market, exchange), quote=True)
    linked = f'<a href="{yahoo_url}"><b>{title_label}</b></a>'
    if str(market or "").upper() == "TW":
        wg_url = html.escape(_wantgoo_chart_url(raw_sym), quote=True)
        linked += f' [<a href="{wg_url}">玩股K線</a>]'
    return linked


def format_post_market_summary(report: Dict[str, Any], top_n: Optional[int] = None) -> str:
    """將盤後海選 JSON 格式化為 Telegram HTML 訊息（預設推送全部 Focus List 標的）。"""
    market = str(report.get("market") or "").upper()
    bm = html.escape(str(report.get("benchmark_symbol") or ""))
    trend = html.escape(str(report.get("benchmark_trend") or "UNKNOWN"))
    stats = report.get("funnel_stats") or {}

    lines = [
        f"📊 <b>[VCP 盤後海選] {html.escape(market)}</b> | 大盤 <code>{bm}</code>: <b>{trend}</b>"
    ]
    if trend == "DOWNTREND":
        lines.append("⚠️ 逆風空頭環境，提高突破門檻")

    comp = report.get("data_completeness") or {}
    comp_warns = comp.get("warnings") or []
    if comp_warns:
        warn_parts = []
        if "TWSE_CHIPS_LAGGING" in comp_warns:
            warn_parts.append(f"TWSE籌碼僅至{comp.get('twse_chips_date') or '-'}")
        if "TPEX_CHIPS_LAGGING" in comp_warns:
            warn_parts.append(f"TPEx籌碼僅至{comp.get('tpex_chips_date') or '-'}")
        if "TWSE_MARGIN_PENDING" in comp_warns:
            warn_parts.append("TWSE融資融券尚未公布")
        if "PRICE_DATA_LAGGING" in comp_warns:
            warn_parts.append(f"K線僅至{comp.get('price_latest_date') or '-'}")
        if "HIGH_FAILURE_RATE" in comp_warns:
            warn_parts.append(f"失敗率偏高({comp.get('failed_count', 0)}/{comp.get('screened_count', 0)})")
        lines.append("⚠️ 資料齊全度警示：" + "、".join(warn_parts or comp_warns))

    oes_part = f"，排除興櫃={stats.get('excluded_oes_count', 0)}" if market == "TW" else ""
    lines.append(
        f"初篩 {stats.get('screened_count', 0)} → 精算 {stats.get('calculated_count', 0)}"
        f"（Stage2={stats.get('stage2_count', 0)}{oes_part}）→ Focus {stats.get('focus_count', 0)} 檔"
    )

    focus_list = report.get("focus_list") or []
    if not focus_list:
        lines.append("\n今日無符合條件標的。")
        return "\n".join(lines)

    shown_items = focus_list if top_n is None else focus_list[:top_n]
    lines.append("")
    for item in shown_items:
        raw_sym = str(item.get("symbol") or "")
        sym = html.escape(raw_sym)
        name_zh = str(item.get("name_zh") or "").strip()
        title_label = f"{sym} {html.escape(name_zh)}" if name_zh else sym
        title_html = _format_symbol_links(raw_sym, title_label, market, str(item.get("exchange") or ""))
        grade = html.escape(str(item.get("focus_grade") or ""))
        score = item.get("vcp_score", 0)
        close_p = float(item.get("close_price") or 0.0)
        pivot = float(item.get("suggested_pivot") or 0.0)
        stop_pct = float(item.get("stop_loss_pct") or 0.0)

        metrics = item.get("metrics") or {}
        g2 = metrics.get("gate2_trend_rs") or {}
        g3 = metrics.get("gate3_catalysts") or {}
        g4 = metrics.get("gate4_setup_risk") or {}

        bbw = g4.get("bbw_120d_percentile")
        bbw_str = f"BBW {float(bbw):.0f}%" if bbw is not None else "BBW -"
        rs_rating = item.get("rs_rating") if item.get("rs_rating") is not None else g2.get("rs_rating")
        if rs_rating is not None:
            rs_str = f"RS{int(rs_rating)}" + ("新高" if g2.get("rs_line_52w_high") else "")
        else:
            rs_str = "RS新高" if g2.get("rs_line_52w_high") else "RS-"

        vcp_tier = str(item.get("vcp_tier") or "").strip()
        tier_prefix = f"{html.escape(vcp_tier)}級/" if vcp_tier else ""
        setup_status = str(item.get("setup_status") or g4.get("setup_status") or "").strip()
        status_badge = ""
        if setup_status == "BREAKOUT":
            status_badge = " 🔥BREAKOUT"
        elif setup_status == "PIVOT_READY":
            status_badge = " 🎯PIVOT_READY"
        dist_p = item.get("dist_to_pivot_pct") if item.get("dist_to_pivot_pct") is not None else g4.get("dist_to_pivot_pct")
        dist_str = f" (距Pivot {float(dist_p):+.1f}%)" if dist_p is not None else ""
        g3_note = _format_gate3_note(market, g3)

        row_head = (
            f"<b>{item.get('rank', '-')}.</b> {title_html}{status_badge} "
            f"[{tier_prefix}{grade}] {score}分 | 收 {close_p:.2f} / Pivot {pivot:.2f}{dist_str} / Stop {stop_pct:.1f}% | {bbw_str} {rs_str}"
        )
        lines.append(row_head)
        if g3_note:
            lines.append(f"   └ {html.escape(g3_note)}")

    if top_n is not None and len(focus_list) > top_n:
        lines.append(f"\n…其餘 {len(focus_list) - top_n} 檔請見 focus.json")

    return "\n".join(lines)


def format_intraday_breakout_alert(alert: Dict[str, Any]) -> str:
    """將盤中樞紐突破觸發資料格式化為 Telegram HTML 警報卡片（供 Phase 3 雷達使用）。"""
    raw_sym = str(alert.get("symbol") or "")
    raw_market = str(alert.get("market") or "TW")
    sym = html.escape(raw_sym)
    market = html.escape(raw_market)
    name_zh = str(alert.get("name_zh") or "").strip()
    title_label = f"{market}:{sym}" + (f" {html.escape(name_zh)}" if name_zh else "")
    title_html = _format_symbol_links(raw_sym, title_label, raw_market, str(alert.get("exchange") or ""))
    last_price = float(alert.get("last_price") or 0.0)
    pivot = float(alert.get("suggested_pivot") or 0.0)
    vol_ratio = alert.get("est_vol_ratio_50d")
    vol_str = f"{float(vol_ratio):.2f}x" if vol_ratio is not None else "-"
    stop_loss = alert.get("suggested_stop_loss")
    stop_pct = alert.get("stop_loss_pct")

    lines = [
        f"🚨 <b>[VCP 樞紐突破警報]</b> {title_html}",
        f"• 現價：<b>{last_price:.2f}</b>（Pivot {pivot:.2f}）",
        f"• 預估全日量比：<b>{vol_str}</b>（50 日均量基準）",
    ]
    if stop_loss is not None:
        pct_str = f"（{float(stop_pct):.2f}%）" if stop_pct is not None else ""
        lines.append(f"• 預設停損：<b>{float(stop_loss):.2f}</b>{pct_str}")
    if alert.get("suggested_shares") is not None:
        risk_amt = alert.get("risk_amount")
        risk_str = f"（風險 {float(risk_amt):,.0f}）" if risk_amt is not None else ""
        lines.append(f"• 1% 風控建議股數：<b>{int(alert['suggested_shares']):,}</b>{risk_str}")
    return "\n".join(lines)


def _run_selftest() -> None:
    long_text = "\n".join(f"Line {i}: abcdefghij" for i in range(400))
    chunks = _split_text(long_text, max_len=1000)
    assert len(chunks) > 1 and all(len(c) <= 1000 for c in chunks), "chunk length exceeded"

    multi = TelegramNotifier(bot_token="x", chat_id="111, -222")
    assert multi.chat_ids == ["111", "-222"] and multi.status()["chat_count"] == 2, multi.status()

    assert _extract_latest_group_chat(
        [{"message": {"chat": {"id": 123, "type": "private"}}}]
    ) is None
    assert _extract_latest_group_chat(
        [
            {
                "my_chat_member": {
                    "chat": {"id": -1001, "type": "supergroup", "title": "Old"},
                    "new_chat_member": {"status": "kicked"},
                }
            }
        ]
    ) is None
    found_sg = _extract_latest_group_chat(
        [
            {
                "my_chat_member": {
                    "chat": {"id": -1002, "type": "supergroup", "title": "VCP Alerts"},
                    "new_chat_member": {"status": "member"},
                }
            }
        ]
    )
    assert found_sg == {"chat_id": "-1002", "type": "supergroup", "title": "VCP Alerts"}, found_sg
    found_grp = _extract_latest_group_chat(
        [{"message": {"chat": {"id": -999, "type": "group", "title": "Team"}}}]
    )
    assert found_grp == {"chat_id": "-999", "type": "group", "title": "Team"}, found_grp
    found_ch = _extract_latest_group_chat(
        [{"channel_post": {"chat": {"id": -1003, "type": "channel", "title": "Ch"}}}]
    )
    assert found_ch == {"chat_id": "-1003", "type": "channel", "title": "Ch"}, found_ch

    sample_report = {
        "market": "TW",
        "benchmark_symbol": "^TWII",
        "benchmark_trend": "DOWNTREND",
        "funnel_stats": {
            "screened_count": 20,
            "calculated_count": 19,
            "stage2_count": 13,
            "excluded_oes_count": 1,
            "focus_count": 13,
        },
        "focus_list": [
            {
                "rank": 1,
                "symbol": "6199<TEST>&",
                "name_zh": "天品",
                "vcp_tier": "S",
                "setup_status": "PIVOT_READY",
                "rs_rating": 92,
                "dist_to_pivot_pct": -1.96,
                "focus_grade": "B_WATCHLIST",
                "vcp_score": 88,
                "close_price": 169.5,
                "suggested_pivot": 172.84,
                "stop_loss_pct": -5.59,
                "metrics": {
                    "gate2_trend_rs": {"rs_line_52w_high": True, "rs_rating": 92},
                    "gate3_catalysts": {
                        "institutional_10d_lots": {"trust": 45, "foreign": 120},
                        "institutional_1d_lots": {"trust": 12, "foreign": -34},
                        "monthly_revenue": {"yoy_pct": 143.5},
                    },
                    "gate4_setup_risk": {"bbw_120d_percentile": 15.8},
                },
            }
        ],
    }
    msg = format_post_market_summary(sample_report)
    assert (
        "&lt;TEST&gt;&amp;" in msg
        and "天品" in msg
        and "排除興櫃=1" in msg
        and "DOWNTREND" in msg
        and "🎯PIVOT_READY" in msg
        and "[S級/B_WATCHLIST]" in msg
        and "RS92新高" in msg
        and "距Pivot -2.0%" in msg
        and "10D投信+45/外資+120張" in msg
        and "https://tw.stock.yahoo.com/quote/6199%3CTEST%3E%26.TW/technical-analysis" in msg
        and "https://www.wantgoo.com/stock/6199%3CTEST%3E%26/technical-chart" in msg
    ), msg

    comp_report = {
        **sample_report,
        "data_completeness": {
            "is_complete": False,
            "twse_chips_date": "20261126",
            "failed_count": 0,
            "screened_count": 20,
            "warnings": ["TWSE_CHIPS_LAGGING", "TWSE_MARGIN_PENDING"],
        },
    }
    comp_msg = format_post_market_summary(comp_report)
    assert "TWSE籌碼僅至20261126" in comp_msg and "TWSE融資融券尚未公布" in comp_msg, comp_msg

    many_report = {
        **sample_report,
        "focus_list": [
            {**sample_report["focus_list"][0], "rank": i + 1, "symbol": str(2300 + i), "name_zh": f"股{i + 1}"}
            for i in range(12)
        ],
    }
    full_msg = format_post_market_summary(many_report)
    assert "股12" in full_msg and "請見 focus.json" not in full_msg, full_msg
    limited_msg = format_post_market_summary(many_report, top_n=2)
    assert "股2" in limited_msg and "股3" not in limited_msg and "其餘 10 檔" in limited_msg, limited_msg

    assert (
        _yahoo_chart_url("NDAQ", "US", "NASDAQ")
        == "https://tw.stock.yahoo.com/quote/NDAQ/technical-analysis"
    )
    assert (
        _yahoo_chart_url("2330", "TW", "TWSE")
        == "https://tw.stock.yahoo.com/quote/2330.TW/technical-analysis"
    )
    assert (
        _yahoo_chart_url("6199.TWO", "TW", "TPEX")
        == "https://tw.stock.yahoo.com/quote/6199.TWO/technical-analysis"
    )
    assert "玩股K線" not in _format_symbol_links("NDAQ", "NDAQ", "US", "NASDAQ")

    alert_msg = format_intraday_breakout_alert(
        {
            "symbol": "6199",
            "name_zh": "天品",
            "market": "TW",
            "exchange": "OTC",
            "last_price": 173.5,
            "suggested_pivot": 172.84,
            "est_vol_ratio_50d": 1.65,
            "suggested_stop_loss": 163.18,
            "stop_loss_pct": -5.59,
            "suggested_shares": 1000,
            "risk_amount": 9660,
        }
    )
    assert (
        "6199" in alert_msg
        and "天品" in alert_msg
        and "https://tw.stock.yahoo.com/quote/6199.TWO/technical-analysis" in alert_msg
        and "https://www.wantgoo.com/stock/6199/technical-chart" in alert_msg
        and "1.65x" in alert_msg
        and "1,000" in alert_msg
    ), alert_msg

    notifier = TelegramNotifier()
    print("PASS: _split_text (long message split under limit)")
    print("PASS: multi-chat TG_CHAT_ID parsing & _extract_latest_group_chat")
    print("PASS: format_post_market_summary (HTML escape & TW funnel formatting)")
    print("PASS: format_intraday_breakout_alert (Phase 3 breakout card)")
    print("Telegram status:", json.dumps(notifier.status(), ensure_ascii=False))


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description="Telegram Bot 通知驗證、群組綁定與 Focus List 推播工具")
    p.add_argument("--selftest", action="store_true", help="執行離線單元自測與設定檢查")
    p.add_argument("--test-send", action="store_true", help="發送測試通知訊息至 Telegram")
    p.add_argument("--send-focus", choices=["TW", "US"], help="讀取並推播最新 Focus List")
    p.add_argument("--bind-group", action="store_true", help="自動抓取最新群組／頻道並寫入 .env")
    p.add_argument("--keep-existing", action="store_true", help="搭配 --bind-group 保留原有私訊通知")
    a = p.parse_args()

    if a.selftest:
        _run_selftest()
        return

    notifier = TelegramNotifier()
    if a.bind_group:
        found = notifier.discover_latest_group_chat()
        if not found:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "error": "尚未偵測到群組／頻道事件，請先將 @StockNtfyBot 加入新群組並發送 /start@StockNtfyBot",
                    },
                    ensure_ascii=False,
                )
            )
            sys.exit(1)

        count = update_env_chat_id(found["chat_id"], keep_existing=a.keep_existing)
        res = notifier.send_message(
            "✅ <b>VCP Trading</b> 群組通知已綁定成功！後續盤後海選與突破警報將推播至此聊天室。",
            target_chat_ids=[found["chat_id"]],
        )
        print(
            json.dumps(
                {
                    "ok": True,
                    "bound_type": found["type"],
                    "bound_title": found["title"],
                    "chat_count": count,
                    "message_ids": res["message_ids"],
                },
                ensure_ascii=False,
            )
        )
        return

    if a.test_send:
        res = notifier.send_message(
            "✅ <b>VCP Trading</b> Telegram 通知連線成功（台股已啟用排除興櫃 OES 過濾）"
        )
        print(json.dumps(res, ensure_ascii=False))
        return

    if a.send_focus:
        focus_path = ROOT / "config" / "watchlists" / f"{a.send_focus.lower()}_focus.json"
        if not focus_path.is_file():
            raise FileNotFoundError(f"找不到 {focus_path}")
        report = json.loads(focus_path.read_text(encoding="utf-8"))
        res = notifier.send_message(format_post_market_summary(report))
        print(json.dumps(res, ensure_ascii=False))
        return

    p.error("請指定 --selftest、--bind-group、--test-send 或 --send-focus TW|US")


if __name__ == "__main__":
    main()
