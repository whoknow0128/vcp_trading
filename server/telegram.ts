import type { PostMarketScanReport } from './types.ts';

function escapeHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function splitText(text: string, maxLen = 3900): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let current: string[] = [];
  let curLen = 0;

  for (const rawLine of text.split('\n')) {
    let line = rawLine;
    const addLen = line.length + (current.length > 0 ? 1 : 0);
    if (curLen + addLen > maxLen) {
      if (current.length > 0) {
        chunks.push(current.join('\n'));
        current = [];
        curLen = 0;
      }
      while (line.length > maxLen) {
        chunks.push(line.slice(0, maxLen));
        line = line.slice(maxLen);
      }
      if (line) {
        current = [line];
        curLen = line.length;
      }
    } else {
      current.push(line);
      curLen += addLen;
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks.length > 0 ? chunks : [''];
}

function formatGate3Note(market: string, g3: Record<string, any>): string {
  if (!g3) return '';
  if (market === 'TW') {
    const parts: string[] = [];
    const inst = g3.institutional_5d_lots || g3.institutional_1d_lots;
    const label = g3.institutional_5d_lots ? '5D' : '1D';
    if (inst) {
      const t = Number(inst.trust || 0);
      const f = Number(inst.foreign || 0);
      parts.push(`${label}投信${t >= 0 ? '+' : ''}${t}/外資${f >= 0 ? '+' : ''}${f}張`);
    }
    const revYoy = g3.monthly_revenue?.yoy_pct;
    if (revYoy !== null && revYoy !== undefined) {
      const r = Number(revYoy);
      parts.push(`營收YoY ${r >= 0 ? '+' : ''}${r.toFixed(1)}%`);
    }
    return parts.join(' | ');
  }

  const parts: string[] = [];
  if (g3.earnings_warning) {
    parts.push('⚠️財報<=7日');
  } else if (g3.trading_days_to_earnings !== null && g3.trading_days_to_earnings !== undefined) {
    parts.push(`距財報${g3.trading_days_to_earnings}日`);
  }
  if (g3.eps_yoy_fq_pct !== null && g3.eps_yoy_fq_pct !== undefined) {
    const e = Number(g3.eps_yoy_fq_pct);
    parts.push(`EPS YoY ${e >= 0 ? '+' : ''}${e.toFixed(1)}%`);
  }
  return parts.join(' | ');
}

export function formatPostMarketSummary(report: PostMarketScanReport, topN = 10): string {
  const market = report.market;
  const bm = escapeHtml(report.benchmark_symbol);
  const trend = escapeHtml(report.benchmark_trend);
  const stats = report.funnel_stats;

  const lines: string[] = [
    `📊 <b>[VCP 盤後海選] ${escapeHtml(market)}</b> | 大盤 <code>${bm}</code>: <b>${trend}</b>`,
  ];
  if (trend === 'DOWNTREND') {
    lines.push('⚠️ 逆風空頭環境，提高突破門檻');
  }

  const oesPart = market === 'TW' ? `，排除興櫃=${stats.excluded_oes_count}` : '';
  lines.push(
    `初篩 ${stats.screened_count} → 精算 ${stats.calculated_count}（Stage2=${stats.stage2_count}${oesPart}）→ Focus ${stats.focus_count} 檔`
  );

  if (!report.focus_list.length) {
    lines.push('\n今日無符合條件標的。');
    return lines.join('\n');
  }

  lines.push('');
  for (const item of report.focus_list.slice(0, topN)) {
    const sym = escapeHtml(item.symbol);
    const nameZh = (item.name_zh || '').trim();
    const titleLabel = nameZh ? `${sym} ${escapeHtml(nameZh)}` : sym;
    const g2 = item.metrics.gate2_trend_rs;
    const g3 = item.metrics.gate3_catalysts;
    const g4 = item.metrics.gate4_setup_risk;

    const bbwStr = `BBW ${g4.bbw_120d_percentile.toFixed(0)}%`;
    const rs52 = g2.rs_line_52w_high ? 'RS新高' : 'RS-';
    const g3Note = formatGate3Note(market, g3);

    lines.push(
      `<b>${item.rank}. ${titleLabel}</b> [${escapeHtml(item.focus_grade)}] ${item.vcp_score}分 | ` +
        `收 ${item.close_price.toFixed(2)} / Pivot ${item.suggested_pivot.toFixed(2)} / Stop ${item.stop_loss_pct.toFixed(1)}% | ${bbwStr} ${rs52}`
    );
    if (g3Note) {
      lines.push(`   └ ${escapeHtml(g3Note)}`);
    }
  }

  if (report.focus_list.length > topN) {
    lines.push(`\n…其餘 ${report.focus_list.length - topN} 檔請見 Focus List`);
  }

  return lines.join('\n');
}

export function formatIntradayBreakoutAlert(alert: {
  symbol: string;
  market: string;
  name_zh?: string;
  last_price: number;
  suggested_pivot: number;
  est_vol_ratio_50d: number | null;
  suggested_stop_loss?: number;
  stop_loss_pct?: number;
  suggested_shares?: number;
  risk_amount?: number;
}): string {
  const sym = escapeHtml(alert.symbol);
  const market = escapeHtml(alert.market || 'TW');
  const nameZh = (alert.name_zh || '').trim();
  const titleLabel = `${market}:${sym}` + (nameZh ? ` ${escapeHtml(nameZh)}` : '');
  const volStr = alert.est_vol_ratio_50d !== null ? `${alert.est_vol_ratio_50d.toFixed(2)}x` : '-';

  const lines = [
    `🚨 <b>[VCP 樞紐突破警報] ${titleLabel}</b>`,
    `• 現價：<b>${alert.last_price.toFixed(2)}</b>（Pivot ${alert.suggested_pivot.toFixed(2)}）`,
    `• 預估全日量比：<b>${volStr}</b>（50 日均量基準）`,
  ];
  if (alert.suggested_stop_loss !== undefined) {
    const pctStr = alert.stop_loss_pct !== undefined ? `（${alert.stop_loss_pct.toFixed(2)}%）` : '';
    lines.push(`• 預設停損：<b>${alert.suggested_stop_loss.toFixed(2)}</b>${pctStr}`);
  }
  if (alert.suggested_shares !== undefined) {
    const riskStr = alert.risk_amount !== undefined ? `（風險 ${Math.round(alert.risk_amount).toLocaleString()}）` : '';
    lines.push(`• 1% 風控建議股數：<b>${alert.suggested_shares.toLocaleString()}</b>${riskStr}`);
  }
  return lines.join('\n');
}

export function getTelegramStatus() {
  const token = (process.env.TG_BOT_TOKEN || '').trim();
  const chatRaw = (process.env.TG_CHAT_ID || '').trim();
  const chatIds = chatRaw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  return {
    configured: Boolean(token && chatIds.length > 0),
    has_bot_token: Boolean(token),
    has_chat_id: chatIds.length > 0,
    chat_count: chatIds.length,
  };
}

export async function sendTelegramMessage(text: string): Promise<{ ok: boolean; message_ids: number[]; targets: number }> {
  const token = (process.env.TG_BOT_TOKEN || '').trim();
  const chatRaw = (process.env.TG_CHAT_ID || '').trim();
  const chatIds = chatRaw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  if (!token || chatIds.length === 0) {
    throw new Error('伺服器尚未設定 TG_BOT_TOKEN / TG_CHAT_ID 環境變數，請於環境變數中填入 Telegram Bot 設定');
  }

  const chunks = splitText(text);
  const messageIds: number[] = [];

  for (const cid of chatIds) {
    for (const chunk of chunks) {
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: cid,
          text: chunk,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      const json: any = await resp.json();
      if (!resp.ok || !json?.ok) {
        throw new Error(`Telegram API 失敗: ${json?.description || resp.status}`);
      }
      if (json.result?.message_id != null) {
        messageIds.push(Number(json.result.message_id));
      }
    }
  }

  return { ok: true, message_ids: messageIds, targets: chatIds.length };
}
