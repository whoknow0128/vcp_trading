import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  Download,
  ExternalLink,
  RefreshCw,
  Search,
  Send,
  X,
} from 'lucide-react';
import type { FocusListItem, MarketType, PostMarketScanReport } from '../types';

interface ScannerViewProps {
  market: MarketType;
  report: PostMarketScanReport | null;
  loading: boolean;
  error: string | null;
  onRunScan: (maxCandidates: number) => void;
  onSelectStock: (symbol: string, market: MarketType) => void;
  onSendToRadar: (item: FocusListItem) => void;
}

type SortField = 'rank' | 'vcp_score' | 'bbw' | 'atr' | 'stop_loss_pct';

function formatGradeText(grade: string): { label: string; colorClass: string } {
  switch (grade) {
    case 'A_CANDIDATE':
      return { label: 'A 級 · 突破候選', colorClass: 'text-emerald-700 font-semibold' };
    case 'B_WATCHLIST':
      return { label: 'B 級 · 緊湊觀察', colorClass: 'text-blue-700 font-semibold' };
    case 'B_EARNINGS_WARNING':
      return { label: 'B 級 · 財報警示', colorClass: 'text-amber-700 font-semibold' };
    case 'B_OR_C_REVIEW':
      return { label: 'B/C 級 · 結構複核', colorClass: 'text-slate-700 font-medium' };
    case 'C_EARNINGS_WARNING':
      return { label: 'C 級 · 財報降級', colorClass: 'text-amber-700 font-medium' };
    default:
      return { label: 'C 級 · 觀望', colorClass: 'text-rose-700 font-medium' };
  }
}

export const ScannerView: React.FC<ScannerViewProps> = ({
  market,
  report,
  loading,
  error,
  onRunScan,
  onSelectStock,
  onSendToRadar,
}) => {
  const [maxCandidates, setMaxCandidates] = useState(30);
  const [searchQuery, setSearchQuery] = useState('');
  const [gradeFilter, setGradeFilter] = useState<'ALL' | 'AB' | 'RS52'>('ALL');
  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortAsc, setSortAsc] = useState(true);

  const [tgPreview, setTgPreview] = useState<string | null>(null);
  const [tgSending, setTgSending] = useState(false);
  const [tgFeedback, setTgFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const marketLabel = market === 'TW' ? '台股' : '美股';

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc((v) => !v);
    } else {
      setSortField(field);
      setSortAsc(field === 'rank' || field === 'bbw' || field === 'atr');
    }
  };

  const filteredList = useMemo(() => {
    if (!report) return [];
    const q = searchQuery.trim().toLowerCase();
    const list = report.focus_list.filter((item) => {
      if (q) {
        const hay = `${item.symbol} ${item.name} ${item.name_zh} ${item.sector || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (gradeFilter === 'AB') {
        if (!['A_CANDIDATE', 'B_WATCHLIST', 'B_EARNINGS_WARNING'].includes(item.focus_grade)) return false;
      } else if (gradeFilter === 'RS52') {
        if (!item.metrics.gate2_trend_rs.rs_line_52w_high) return false;
      }
      return true;
    });

    return [...list].sort((a, b) => {
      let va = 0;
      let vb = 0;
      if (sortField === 'rank') {
        va = a.rank;
        vb = b.rank;
      } else if (sortField === 'vcp_score') {
        va = a.vcp_score;
        vb = b.vcp_score;
      } else if (sortField === 'bbw') {
        va = a.metrics.gate4_setup_risk.bbw_120d_percentile;
        vb = b.metrics.gate4_setup_risk.bbw_120d_percentile;
      } else if (sortField === 'atr') {
        va = a.metrics.gate4_setup_risk.atr_5_20_ratio;
        vb = b.metrics.gate4_setup_risk.atr_5_20_ratio;
      } else {
        va = a.stop_loss_pct;
        vb = b.stop_loss_pct;
      }
      return sortAsc ? va - vb : vb - va;
    });
  }, [report, searchQuery, gradeFilter, sortField, sortAsc]);

  const handleExportJson = () => {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${report.market.toLowerCase()}_focus_${report.generated_at.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePreviewTelegram = async () => {
    if (!report) return;
    setTgFeedback(null);
    try {
      const resp = await fetch('/api/telegram/preview-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market: report.market, report }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || '無法產生預覽');
      setTgPreview(json.html);
    } catch (err) {
      setTgFeedback({ ok: false, msg: err instanceof Error ? err.message : '無法產生預覽' });
    }
  };

  const handlePushTelegram = async () => {
    if (!tgPreview) return;
    setTgSending(true);
    setTgFeedback(null);
    try {
      const resp = await fetch('/api/telegram/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: tgPreview }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || '推播失敗');
      setTgFeedback({
        ok: true,
        msg: `已成功推播至 ${json.targets} 個 Telegram 聊天室。`,
      });
    } catch (err) {
      setTgFeedback({ ok: false, msg: err instanceof Error ? err.message : '推播失敗' });
    } finally {
      setTgSending(false);
    }
  };

  const trendLabel =
    report?.benchmark_trend === 'UPTREND'
      ? { text: '多頭順風（站上 50MA 與 200MA）', cls: 'text-emerald-700' }
      : report?.benchmark_trend === 'MIXED'
        ? { text: '震盪分歧（站上 200MA、跌破 50MA）', cls: 'text-amber-700' }
        : report?.benchmark_trend === 'DOWNTREND'
          ? { text: '空頭逆風（提高突破門檻）', cls: 'text-rose-700' }
          : { text: '尚未執行掃描', cls: 'text-slate-500' };

  return (
    <div className="space-y-6">
      {/* Scanner Controls Bar */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-5 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-display font-bold tracking-tight text-slate-900">
            盤後全市場 SEPA × VCP 漏斗海選
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            透過 TradingView Stage 2 全市場初篩，結合還原權息日 K 四關卡精算
            {market === 'TW'
              ? '，並自動整合證交所／櫃買中心法人籌碼與排除興櫃 OES 標的。'
              : '，並自動偵測 7 個交易日內財報防雷降級。'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
            <span className="whitespace-nowrap">初篩池上限</span>
            <select
              value={maxCandidates}
              onChange={(e) => setMaxCandidates(Number(e.target.value))}
              className="px-2.5 py-2 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option value={20}>前 20 檔（快速）</option>
              <option value={30}>前 30 檔（均衡）</option>
              <option value={45}>前 45 檔（深度）</option>
              <option value={60}>前 60 檔（完整）</option>
            </select>
          </label>

          <button
            type="button"
            disabled={loading}
            onClick={() => onRunScan(maxCandidates)}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            {loading ? `正在掃描${marketLabel}...` : `執行${marketLabel}漏斗海選`}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 border border-rose-200 bg-rose-50/70 rounded-lg text-sm text-rose-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-rose-700" />
          <div>
            <p className="font-medium">盤後海選執行失敗</p>
            <p className="text-xs mt-0.5 text-rose-700">{error}</p>
          </div>
        </div>
      )}

      {/* Funnel Summary Metrics */}
      {report && (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4 border border-slate-200 rounded-lg p-5 bg-slate-50/50">
          <div className="col-span-2 lg:col-span-2 pr-4 lg:border-r border-slate-200">
            <div className="text-xs text-slate-500">
              第 1 關大盤基準 · {report.benchmark_symbol}
            </div>
            <div className={`mt-1 text-base font-display font-semibold ${trendLabel.cls}`}>
              {trendLabel.text}
            </div>
            <div className="mt-1 text-xs text-slate-500 font-mono">
              更新時間 {new Date(report.generated_at).toLocaleString('zh-TW')}
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500">初篩入圍</div>
            <div className="mt-1 text-xl font-mono font-semibold text-slate-900 tabular-nums">
              {report.funnel_stats.screened_count}
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              {market === 'TW'
                ? `排除興櫃：${report.funnel_stats.excluded_oes_count} 檔`
                : `精算成功：${report.funnel_stats.calculated_count} 檔`}
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500">Stage 2 合格</div>
            <div className="mt-1 text-xl font-mono font-semibold text-emerald-700 tabular-nums">
              {report.funnel_stats.stage2_count}
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              趨勢樣板複核通過
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500">緊湊 VCP 型態</div>
            <div className="mt-1 text-xl font-mono font-semibold text-blue-700 tabular-nums">
              {report.funnel_stats.vcp_tight_count}
            </div>
            <div className="mt-0.5 text-xs text-slate-500">
              BBW≤25% · ATRr≤0.75
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500">Focus 精選清單</div>
            <div className="mt-1 text-xl font-mono font-semibold text-slate-900 tabular-nums">
              {report.funnel_stats.focus_count}
            </div>
            <div className="mt-0.5 text-xs text-amber-700">
              {report.funnel_stats.earnings_warning_count > 0
                ? `${report.funnel_stats.earnings_warning_count} 檔財報防雷警示`
                : '可載入盤中雷達'}
            </div>
          </div>
        </div>
      )}

      {/* Loading Skeleton */}
      {loading && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
            正在執行 TradingView Stage 2 初篩、抓取還原權息歷史日 K，並整合{market === 'TW' ? '證交所／櫃買中心法人籌碼與月營收' : '美股財報日與季度成長率'}...
          </div>
          <div className="divide-y divide-slate-100">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className="grid grid-cols-12 gap-4 px-5 py-3.5 animate-pulse">
                <div className="col-span-1 h-4 bg-slate-100 rounded" />
                <div className="col-span-2 h-4 bg-slate-200 rounded" />
                <div className="col-span-2 h-4 bg-slate-100 rounded" />
                <div className="col-span-2 h-4 bg-slate-100 rounded" />
                <div className="col-span-2 h-4 bg-slate-100 rounded" />
                <div className="col-span-3 h-4 bg-slate-100 rounded" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {!loading && !report && (
        <div className="border border-slate-200 rounded-lg py-16 px-6 text-center bg-slate-50/40">
          <h2 className="text-lg font-display font-semibold text-slate-900">
            尚未產生{marketLabel}盤後 Focus List
          </h2>
          <p className="mt-2 text-sm text-slate-600 max-w-lg mx-auto">
            點擊下方按鈕啟動即時盤後漏斗海選，自動篩選{market === 'US' ? '美股 NASDAQ / NYSE / AMEX' : '台股上市／上櫃主板'} Stage 2 強勢股、精算還原 VCP 波動收縮指標並產出排序名單。
          </p>
          <button
            type="button"
            onClick={() => onRunScan(maxCandidates)}
            className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            立即執行{marketLabel}盤後海選
          </button>
        </div>
      )}

      {/* Populated Focus List Table */}
      {!loading && report && (
        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-200">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜尋代號、名稱或產業..."
                  className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-md w-56 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="flex items-center p-0.5 bg-slate-100 rounded-md">
                {(
                  [
                    { id: 'ALL', label: `全部 (${report.focus_list.length})` },
                    { id: 'AB', label: 'A / B 級標的' },
                    { id: 'RS52', label: 'RS 創 52 週新高' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setGradeFilter(tab.id)}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      gradeFilter === tab.id
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePreviewTelegram}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                Telegram 推播預覽
              </button>
              <button
                type="button"
                onClick={handleExportJson}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                匯出 JSON
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                  <th className="py-2.5 pl-5 pr-2 w-12">
                    <button
                      type="button"
                      onClick={() => handleSort('rank')}
                      className="inline-flex items-center gap-1 hover:text-slate-900 cursor-pointer"
                    >
                      # <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2.5 px-3">代號與名稱</th>
                  <th className="py-2.5 px-3">精選評級</th>
                  <th className="py-2.5 px-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleSort('vcp_score')}
                      className="inline-flex items-center gap-1 hover:text-slate-900 cursor-pointer"
                    >
                      評分 <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2.5 px-3 text-right">收盤價</th>
                  <th className="py-2.5 px-3 text-right">樞紐價</th>
                  <th className="py-2.5 px-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleSort('stop_loss_pct')}
                      className="inline-flex items-center gap-1 hover:text-slate-900 cursor-pointer"
                    >
                      停損 % <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleSort('bbw')}
                      className="inline-flex items-center gap-1 hover:text-slate-900 cursor-pointer"
                    >
                      BBW 百分位 <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2.5 px-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleSort('atr')}
                      className="inline-flex items-center gap-1 hover:text-slate-900 cursor-pointer"
                    >
                      ATR 5/20 <ArrowUpDown className="w-3 h-3" />
                    </button>
                  </th>
                  <th className="py-2.5 px-3">RS / 關鍵訊號</th>
                  <th className="py-2.5 pl-3 pr-5 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredList.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="py-10 text-center text-slate-500">
                      無符合目前篩選條件的標的。
                    </td>
                  </tr>
                ) : (
                  filteredList.map((item) => {
                    const grade = formatGradeText(item.focus_grade);
                    const g2 = item.metrics.gate2_trend_rs;
                    const g3 = item.metrics.gate3_catalysts || {};
                    const g4 = item.metrics.gate4_setup_risk;

                    const signals: string[] = [];
                    if (g2.rs_line_52w_high) signals.push('RS 52週新高');
                    if (g4.is_vdu_3d) signals.push('極度量縮 VDU');
                    if (g4.pocket_pivot_in_5d) signals.push('口袋支點');
                    if (item.warnings.includes('EARNINGS_WARNING')) signals.push('財報≤7日');

                    const catalystNote =
                      market === 'TW'
                        ? g3.monthly_revenue?.yoy_pct != null
                          ? `月營收 YoY ${g3.monthly_revenue.yoy_pct > 0 ? '+' : ''}${g3.monthly_revenue.yoy_pct}%`
                          : null
                        : g3.eps_yoy_fq_pct != null
                          ? `EPS YoY ${g3.eps_yoy_fq_pct > 0 ? '+' : ''}${g3.eps_yoy_fq_pct}%`
                          : null;

                    return (
                      <tr
                        key={item.symbol}
                        className="hover:bg-slate-50/90 transition-colors"
                      >
                        <td className="py-3 pl-5 pr-2 font-mono text-slate-400 tabular-nums">
                          {item.rank}
                        </td>
                        <td className="py-3 px-3">
                          <button
                            type="button"
                            onClick={() => onSelectStock(item.symbol, report.market)}
                            className="text-left group cursor-pointer"
                          >
                            <div className="font-mono font-semibold text-slate-900 group-hover:text-blue-700">
                              {item.symbol}
                              {item.name_zh && (
                                <span className="ml-1.5 font-sans font-medium text-slate-700">
                                  {item.name_zh}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-500 truncate max-w-[200px]">
                              {item.name}
                              {item.sector ? ` · ${item.sector}` : ''}
                            </div>
                          </button>
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <span className={grade.colorClass}>{grade.label}</span>
                          {catalystNote && (
                            <div className="text-[11px] text-slate-500 font-mono mt-0.5">{catalystNote}</div>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-semibold text-slate-900 tabular-nums">
                          {item.vcp_score}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-slate-900 tabular-nums">
                          {item.close_price.toFixed(2)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono font-medium text-emerald-700 tabular-nums">
                          {item.suggested_pivot.toFixed(2)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-rose-700 tabular-nums">
                          {item.stop_loss_pct.toFixed(2)}%
                        </td>
                        <td
                          className={`py-3 px-3 text-right font-mono tabular-nums ${
                            g4.bbw_120d_percentile <= 25 ? 'text-emerald-700 font-semibold' : 'text-slate-700'
                          }`}
                        >
                          {g4.bbw_120d_percentile.toFixed(1)}%
                        </td>
                        <td
                          className={`py-3 px-3 text-right font-mono tabular-nums ${
                            g4.atr_5_20_ratio <= 0.75 ? 'text-emerald-700 font-semibold' : 'text-slate-700'
                          }`}
                        >
                          {g4.atr_5_20_ratio.toFixed(2)}
                        </td>
                        <td className="py-3 px-3 text-slate-600">
                          {signals.length > 0 ? signals.join(' · ') : '—'}
                        </td>
                        <td className="py-3 pl-3 pr-5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => onSelectStock(item.symbol, report.market)}
                              className="text-blue-700 hover:text-blue-900 font-medium inline-flex items-center gap-1 cursor-pointer"
                            >
                              診斷
                              <ExternalLink className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onSendToRadar(item)}
                              className="text-slate-600 hover:text-slate-900 font-medium cursor-pointer"
                            >
                              雷達
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Telegram Preview Modal */}
      {tgPreview !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="bg-white border border-slate-200 rounded-lg max-w-2xl w-full shadow-lg overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200">
              <h3 className="font-display font-semibold text-sm text-slate-900">
                Telegram 盤後海選摘要推播預覽
              </h3>
              <button
                type="button"
                onClick={() => setTgPreview(null)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                aria-label="關閉視窗"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5">
              <pre className="p-4 bg-slate-50 border border-slate-200 rounded-md text-xs font-mono whitespace-pre-wrap text-slate-800 max-h-80 overflow-y-auto">
                {tgPreview}
              </pre>
              {tgFeedback && (
                <div
                  className={`mt-3 flex items-center gap-2 text-xs ${
                    tgFeedback.ok ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {tgFeedback.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                  <span>{tgFeedback.msg}</span>
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3.5 bg-slate-50 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setTgPreview(null)}
                className="px-3.5 py-2 text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
              >
                關閉
              </button>
              <button
                type="button"
                disabled={tgSending}
                onClick={handlePushTelegram}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                {tgSending ? '發送中...' : '推播至已設定之 Telegram 聊天室'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
