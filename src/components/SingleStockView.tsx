import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileSpreadsheet,
  Search,
  XCircle,
} from 'lucide-react';
import type { MarketType, SingleStockResponse } from '../types';
import { VcpChart } from './VcpChart';

interface SingleStockViewProps {
  market: MarketType;
  initialSymbol?: string;
  onSendToRadar: (payload: {
    symbol: string;
    market: MarketType;
    nameZh?: string;
    closePrice: number;
    pivot: number;
    stopLoss: number;
    volMa50: number;
  }) => void;
}

const PRESETS: Record<MarketType, string[]> = {
  US: ['NVDA', 'META', 'AVGO', 'MSFT', 'PLTR', 'AAPL'],
  TW: ['2330', '2454', '2317', '2382', '3017', '2308'],
};

function StatusRow({
  label,
  value,
  pass,
  neutral,
}: {
  label: string;
  value: string;
  pass?: boolean;
  neutral?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-slate-100 last:border-b-0 text-xs">
      <span className="text-slate-600">{label}</span>
      <span
        className={`font-mono font-medium tabular-nums inline-flex items-center gap-1.5 text-right ${
          neutral ? 'text-slate-900' : pass ? 'text-emerald-700' : 'text-rose-700'
        }`}
      >
        {!neutral &&
          (pass ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />)}
        {value}
      </span>
    </div>
  );
}

function formatTrendZh(trend: string): string {
  if (trend === 'UPTREND') return '多頭順風';
  if (trend === 'MIXED') return '震盪分歧';
  if (trend === 'DOWNTREND') return '空頭逆風';
  return trend;
}

export const SingleStockView: React.FC<SingleStockViewProps> = ({
  market,
  initialSymbol,
  onSendToRadar,
}) => {
  const [symbolInput, setSymbolInput] = useState(initialSymbol || (market === 'TW' ? '2330' : 'NVDA'));
  const [data, setData] = useState<SingleStockResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [copied, setCopied] = useState(false);

  const [csvMode, setCsvMode] = useState(false);
  const [csvText, setCsvText] = useState('');

  const runLookup = async (sym: string, mkt: MarketType) => {
    const clean = sym.trim().toUpperCase();
    if (!clean) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(
        `/api/single-stock?symbol=${encodeURIComponent(clean)}&market=${encodeURIComponent(mkt)}`
      );
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || '診斷失敗');
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法取得個股歷史資料');
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialSymbol) {
      setSymbolInput(initialSymbol);
      runLookup(initialSymbol, market);
    } else if (!data || data.result.meta.market !== market) {
      const defaultSym = market === 'TW' ? '2330' : 'NVDA';
      setSymbolInput(defaultSym);
      runLookup(defaultSym, market);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSymbol, market]);

  const handleCsvSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!csvText.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch('/api/single-stock/csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: symbolInput.trim().toUpperCase() || 'CUSTOM',
          market,
          stockCsv: csvText,
        }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'CSV 運算失敗');
      setData(json);
      setCsvMode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CSV 解析失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyJson = async () => {
    if (!data) return;
    await navigator.clipboard.writeText(JSON.stringify(data.result, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const m = data?.result;
  const g1 = m?.gate1_market;
  const g2 = m?.gate2_trend_rs;
  const g3 = m?.gate3_catalysts;
  const g4 = m?.gate4_setup_risk;

  const gradeSummary =
    m?.meta.pre_filter_grade === 'A_CANDIDATE'
      ? { text: 'A 級 · 樞紐突破候選（觸發進場）', cls: 'text-emerald-700' }
      : m?.meta.pre_filter_grade === 'B_WATCHLIST'
        ? { text: 'B 級 · 右側緊湊整理（高度關注）', cls: 'text-blue-700' }
        : m?.meta.pre_filter_grade === 'B_OR_C_REVIEW'
          ? { text: 'B/C 級 · Stage 2 結構複核', cls: 'text-amber-700' }
          : { text: 'C 級 · 保持空手觀望（暫不進場）', cls: 'text-rose-700' };

  return (
    <div className="space-y-6">
      {/* Header & Query Bar */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-5 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-display font-bold tracking-tight text-slate-900">
            單股四關卡 VCP 深度診斷
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            採用還原權息日 K 執行 Mark Minervini SEPA × VCP 量化運算 — 嚴禁落後震盪指標（KD、RSI、MACD）。
          </p>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            runLookup(symbolInput, market);
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
              placeholder={market === 'TW' ? '例如 2330、2454' : '例如 NVDA、META'}
              className="pl-9 pr-3 py-2 text-xs font-mono border border-slate-300 rounded-md w-44 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {loading ? '診斷中...' : '開始診斷'}
          </button>
          <button
            type="button"
            onClick={() => setCsvMode((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            CSV 匯入
          </button>
        </form>
      </div>

      {/* Quick Ticker Bar */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span>常用{market === 'TW' ? '台股' : '美股'}標的：</span>
        {PRESETS[market].map((sym) => (
          <button
            key={sym}
            type="button"
            onClick={() => {
              setSymbolInput(sym);
              runLookup(sym, market);
            }}
            className={`px-2.5 py-1 font-mono rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              m?.meta.symbol === sym
                ? 'border-blue-700 text-blue-700 bg-blue-50/50 font-semibold'
                : 'border-slate-200 text-slate-700 hover:border-slate-400'
            }`}
          >
            {sym}
          </button>
        ))}
      </div>

      {/* Custom CSV Import Panel */}
      {csvMode && (
        <form onSubmit={handleCsvSubmit} className="border border-slate-200 rounded-lg p-5 bg-slate-50/50 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-display font-semibold text-slate-900">
              自訂還原日線 OHLCV CSV 匯入模式
            </h2>
            <button
              type="button"
              onClick={() => setCsvMode(false)}
              className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer"
            >
              取消
            </button>
          </div>
          <p className="text-xs text-slate-600">
            請貼上包含 <code className="text-slate-800">date,open,high,low,close,volume</code> 欄位的還原日 K 資料（至少 {market === 'TW' ? 265 : 225} 根）；大盤基準（{market === 'TW' ? '^TWII' : 'QQQ'}）將由系統自動抓取。
          </p>
          <textarea
            rows={6}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder="date,open,high,low,close,volume&#10;2025-01-02,135.2,138.9,134.1,138.3,45200100"
            className="w-full p-3 text-xs font-mono bg-white border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={loading || !csvText.trim()}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md cursor-pointer"
            >
              以 CSV 計算 VCP 指標
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="flex items-start gap-3 p-4 border border-rose-200 bg-rose-50/70 rounded-lg text-sm text-rose-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-rose-700" />
          <div>
            <p className="font-medium">診斷執行失敗</p>
            <p className="text-xs mt-0.5 text-rose-700">{error}</p>
          </div>
        </div>
      )}

      {loading && (
        <div className="border border-slate-200 rounded-lg p-12 text-center text-sm text-slate-500">
          正在抓取還原權息歷史 K 線並計算 SEPA × VCP 四關卡指標...
        </div>
      )}

      {!loading && data && m && g1 && g2 && g4 && (
        <div className="space-y-6">
          {/* Decision Banner & Key Levels */}
          <div className="border border-slate-200 rounded-lg p-5 bg-white">
            <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100">
              <div>
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <h2 className="text-2xl font-mono font-bold text-slate-900">
                    {m.meta.symbol}
                  </h2>
                  {g3?.name_zh && (
                    <span className="text-lg font-display font-semibold text-slate-700">
                      {g3.name_zh}
                    </span>
                  )}
                  <span className="text-xs text-slate-500">
                    {m.meta.market === 'TW' ? '台股' : '美股'} · 均線 {m.meta.ma_mode.replace(/_/g, '/')} · 資料日期 {m.meta.data_date}
                  </span>
                </div>
                <div className={`mt-1.5 text-sm font-medium ${gradeSummary.cls}`}>
                  {gradeSummary.text}
                  <span className="text-slate-400 mx-2">·</span>
                  <span className="font-mono text-slate-700">VCP 綜合評分 {data.vcp_score}/100</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    onSendToRadar({
                      symbol: m.meta.symbol,
                      market: m.meta.market,
                      nameZh: g3?.name_zh,
                      closePrice: m.meta.close_price,
                      pivot: g4.suggested_pivot,
                      stopLoss: g4.suggested_stop_loss,
                      volMa50: data.vol_ma50,
                    })
                  }
                  className="px-3.5 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  送入突破雷達
                </button>
                <button
                  type="button"
                  onClick={() => setShowJson((v) => !v)}
                  className="px-3.5 py-2 text-xs font-medium text-slate-700 border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {showJson ? '隱藏 JSON' : '檢視標準 JSON'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 pt-4">
              <div>
                <div className="text-xs text-slate-500">還原收盤價</div>
                <div className="mt-1 text-lg font-mono font-semibold text-slate-900 tabular-nums">
                  {m.meta.close_price.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">建議樞紐價 (+0.2%)</div>
                <div className="mt-1 text-lg font-mono font-semibold text-emerald-700 tabular-nums">
                  {g4.suggested_pivot.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">防守停損價 (上限 8%)</div>
                <div className="mt-1 text-lg font-mono font-semibold text-rose-700 tabular-nums">
                  {g4.suggested_stop_loss.toFixed(2)}
                </div>
                <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                  {g4.stop_loss_pct.toFixed(2)}% ({g4.stop_loss_in_atr.toFixed(2)}× ATR)
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">BBW 120 日百分位</div>
                <div
                  className={`mt-1 text-lg font-mono font-semibold tabular-nums ${
                    g4.bbw_120d_percentile <= 25 ? 'text-emerald-700' : 'text-slate-900'
                  }`}
                >
                  {g4.bbw_120d_percentile.toFixed(1)}%
                </div>
                <div className="text-[11px] font-mono text-slate-500">
                  目前帶寬 {g4.bbw_current_pct.toFixed(2)}%
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">ATR(5) / ATR(20)</div>
                <div
                  className={`mt-1 text-lg font-mono font-semibold tabular-nums ${
                    g4.atr_5_20_ratio <= 0.75 ? 'text-emerald-700' : 'text-slate-900'
                  }`}
                >
                  {g4.atr_5_20_ratio.toFixed(3)}
                </div>
                <div className="text-[11px] font-mono text-slate-500">
                  20 日 ADR {g4.adr_20d_pct.toFixed(2)}%
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500">近 10 日緊湊振幅</div>
                <div
                  className={`mt-1 text-lg font-mono font-semibold tabular-nums ${
                    g4.tightness_10d_pct <= 10 ? 'text-emerald-700' : 'text-slate-900'
                  }`}
                >
                  {g4.tightness_10d_pct.toFixed(2)}%
                </div>
                <div className="text-[11px] font-mono text-slate-500">
                  區間 {g4.recent_10d_low.toFixed(2)} – {g4.recent_10d_high.toFixed(2)}
                </div>
              </div>
            </div>
          </div>

          {/* Interactive VCP Chart */}
          <VcpChart
            data={data.chart}
            market={m.meta.market}
            symbol={m.meta.symbol}
            benchmarkSymbol={m.meta.benchmark_symbol}
            pivot={g4.suggested_pivot}
            stopLoss={g4.suggested_stop_loss}
          />

          {/* 4-Gate Diagnostic Matrix */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Gate 1 & Gate 2 */}
            <div className="space-y-6">
              <div className="border border-slate-200 rounded-lg p-5 bg-white">
                <div className="flex items-center justify-between pb-3 mb-2 border-b border-slate-200">
                  <h3 className="text-sm font-display font-semibold text-slate-900">
                    第 1 關・大盤與基準趨勢（{m.meta.benchmark_symbol}）
                  </h3>
                  <span
                    className={`text-xs font-semibold ${
                      g1.benchmark_trend === 'UPTREND'
                        ? 'text-emerald-700'
                        : g1.benchmark_trend === 'MIXED'
                          ? 'text-amber-700'
                          : 'text-rose-700'
                    }`}
                  >
                    {formatTrendZh(g1.benchmark_trend)}
                  </span>
                </div>
                <StatusRow
                  label={`${m.meta.benchmark_symbol} 站上 50 日均線`}
                  value={g1.benchmark_above_50ma ? '站上（合格）' : '跌破'}
                  pass={g1.benchmark_above_50ma}
                />
                <StatusRow
                  label={`${m.meta.benchmark_symbol} 站上 200 日均線`}
                  value={g1.benchmark_above_200ma ? '站上（合格）' : '跌破'}
                  pass={g1.benchmark_above_200ma}
                />
              </div>

              <div className="border border-slate-200 rounded-lg p-5 bg-white">
                <div className="flex items-center justify-between pb-3 mb-2 border-b border-slate-200">
                  <h3 className="text-sm font-display font-semibold text-slate-900">
                    第 2 關・Stage 2 趨勢樣板與相對強度（RS）
                  </h3>
                  <span
                    className={`text-xs font-semibold ${
                      g2.stage2_template_pass ? 'text-emerald-700' : 'text-rose-700'
                    }`}
                  >
                    {g2.stage2_template_pass ? 'Stage 2 合格' : '一票否決・未過'}
                  </span>
                </div>
                <StatusRow
                  label="各期均線數值"
                  value={Object.entries(g2.ma_values)
                    .map(([k, v]) => `${k.toUpperCase()} ${v.toFixed(1)}`)
                    .join(' · ')}
                  neutral
                />
                <StatusRow
                  label="長期均線近 1 月上升（20 個交易日）"
                  value={g2.ma_long_rising_1m ? '上升中' : '走平 / 下彎'}
                  pass={g2.ma_long_rising_1m}
                />
                <StatusRow
                  label="距離 52 週高點（門檻 ≥ -25%）"
                  value={`${g2.pct_from_52w_high.toFixed(2)}%`}
                  pass={g2.pct_from_52w_high >= -25}
                />
                <StatusRow
                  label="高於 52 週低點幅度（門檻 ≥ +25%）"
                  value={`+${g2.pct_from_52w_low.toFixed(2)}%`}
                  pass={g2.pct_from_52w_low >= 25}
                />
                <StatusRow
                  label="RS 線創 52 週新高（容許 0.5% 誤差）"
                  value={g2.rs_line_52w_high ? '創波段新高' : '未創高'}
                  pass={g2.rs_line_52w_high}
                />
                <StatusRow
                  label="RS 線位於 RS 50 日均線之上"
                  value={g2.rs_above_ma50 ? '站上均線' : '位於下方'}
                  pass={g2.rs_above_ma50}
                />
              </div>
            </div>

            {/* Gate 3 & Gate 4 */}
            <div className="space-y-6">
              <div className="border border-slate-200 rounded-lg p-5 bg-white">
                <div className="flex items-center justify-between pb-3 mb-2 border-b border-slate-200">
                  <h3 className="text-sm font-display font-semibold text-slate-900">
                    第 3 關・基本面催化劑與機構法人籌碼
                  </h3>
                  <span className="text-xs text-slate-500">
                    {g3?.source || (g3?.status ? '待補驗證' : '資料源')}
                  </span>
                </div>

                {m.meta.market === 'US' ? (
                  <>
                    <StatusRow label="所屬產業板塊" value={g3?.sector || '—'} neutral />
                    <StatusRow
                      label="下次財報日（7 交易日內防雷）"
                      value={
                        g3?.next_earnings_date
                          ? `${g3.next_earnings_date}（距今 ${g3.trading_days_to_earnings} 交易日）`
                          : '尚無排程'
                      }
                      pass={!g3?.earnings_warning}
                    />
                    <StatusRow
                      label="單季稀釋 EPS 年增率 (YoY)"
                      value={g3?.eps_yoy_fq_pct != null ? `${g3.eps_yoy_fq_pct > 0 ? '+' : ''}${g3.eps_yoy_fq_pct}%` : '無資料'}
                      pass={g3?.eps_yoy_fq_pct != null && g3.eps_yoy_fq_pct > 15}
                      neutral={g3?.eps_yoy_fq_pct == null}
                    />
                    <StatusRow
                      label="單季總營收年增率 (YoY)"
                      value={
                        g3?.revenue_yoy_fq_pct != null
                          ? `${g3.revenue_yoy_fq_pct > 0 ? '+' : ''}${g3.revenue_yoy_fq_pct}%`
                          : '無資料'
                      }
                      pass={g3?.revenue_yoy_fq_pct != null && g3.revenue_yoy_fq_pct > 15}
                      neutral={g3?.revenue_yoy_fq_pct == null}
                    />
                  </>
                ) : (
                  <>
                    <StatusRow
                      label="掛牌市場與產業別"
                      value={`${g3?.market_board === 'TWSE' ? '上市 (TWSE)' : g3?.market_board === 'TPEX' ? '上櫃 (TPEx)' : '—'} · ${g3?.industry || '—'}`}
                      neutral
                    />
                    <StatusRow
                      label="最新 1 日三大法人買賣超（張）"
                      value={
                        g3?.institutional_1d_lots
                          ? `投信 ${g3.institutional_1d_lots.trust >= 0 ? '+' : ''}${g3.institutional_1d_lots.trust} · 外資 ${g3.institutional_1d_lots.foreign >= 0 ? '+' : ''}${g3.institutional_1d_lots.foreign}`
                          : '無資料'
                      }
                      neutral
                    />
                    <StatusRow
                      label="近 5 日法人累積 / 投信連買"
                      value={
                        g3?.institutional_5d_lots
                          ? `投信 ${g3.institutional_5d_lots.trust >= 0 ? '+' : ''}${g3.institutional_5d_lots.trust} 張（連買 ${g3.trust_buy_streak_days || 0} 日）`
                          : `投信連買 ${g3?.trust_buy_streak_days || 0} 日`
                      }
                      pass={(g3?.trust_buy_streak_days || 0) > 0}
                      neutral={!g3?.institutional_5d_lots}
                    />
                    <StatusRow
                      label="最新月營收年增率 / 月增率"
                      value={
                        g3?.monthly_revenue
                          ? `${g3.monthly_revenue.year_month || ''} · YoY ${g3.monthly_revenue.yoy_pct ?? '無'}% · MoM ${g3.monthly_revenue.mom_pct ?? '無'}%`
                          : '無資料'
                      }
                      pass={g3?.monthly_revenue?.yoy_pct != null && g3.monthly_revenue.yoy_pct > 15}
                      neutral={g3?.monthly_revenue?.yoy_pct == null}
                    />
                    <StatusRow
                      label="融資餘額與單日增減（張）"
                      value={
                        g3?.margin
                          ? `${g3.margin.margin_balance_lots.toLocaleString()}（${g3.margin.margin_change_lots >= 0 ? '+' : ''}${g3.margin.margin_change_lots}）`
                          : '無資料'
                      }
                      neutral
                    />
                  </>
                )}
              </div>

              <div className="border border-slate-200 rounded-lg p-5 bg-white">
                <div className="flex items-center justify-between pb-3 mb-2 border-b border-slate-200">
                  <h3 className="text-sm font-display font-semibold text-slate-900">
                    第 4 關・VCP 收縮結構、量價與 ATR 風控
                  </h3>
                  <span className="text-xs font-mono text-slate-500">
                    50 日均量 {data.vol_ma50.toLocaleString()}
                  </span>
                </div>
                <StatusRow
                  label="股價穩守布林中軌（20MA）之上"
                  value={g4.price_above_bb_mid ? '站上 20MA' : '跌破 20MA'}
                  pass={g4.price_above_bb_mid}
                />
                <StatusRow
                  label="當日量比 vs 50 日均量（突破門檻 ≥ 1.4x）"
                  value={`${g4.vol_ratio_50d.toFixed(2)}x`}
                  neutral
                />
                <StatusRow
                  label="近 3 日極度量縮（VDU < 70% 50 日均量）"
                  value={g4.is_vdu_3d ? '量縮賣壓枯竭' : '尚未量縮'}
                  pass={g4.is_vdu_3d}
                />
                <StatusRow
                  label="近 5 日出現口袋支點（Pocket Pivot）"
                  value={g4.pocket_pivot_in_5d ? '偵測到吸籌支點' : '無'}
                  pass={g4.pocket_pivot_in_5d}
                />
                <StatusRow
                  label="近 10 日出貨日統計（否決門檻 ≥ 3 日）"
                  value={`${g4.distribution_days_10d} 日`}
                  pass={g4.distribution_days_10d < 3}
                />
                <StatusRow
                  label="距離 10MA 乖離度（過熱否決 > 3.5× ATR）"
                  value={`${g4.dist_from_10ma_in_atr.toFixed(2)}× ATR`}
                  pass={g4.dist_from_10ma_in_atr <= 3.5}
                />
              </div>
            </div>
          </div>

          {/* Standardized JSON Output Viewer */}
          {showJson && (
            <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
              <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-slate-50">
                <span className="text-xs font-medium text-slate-700">
                  標準化 VCP 指標 JSON 摘要（{data.data_source} · 耗時 {data.elapsed_ms}ms）
                </span>
                <button
                  type="button"
                  onClick={handleCopyJson}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 cursor-pointer"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? '已複製' : '複製 JSON'}
                </button>
              </div>
              <pre className="p-5 text-xs font-mono text-slate-800 overflow-x-auto max-h-96">
                {JSON.stringify(m, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
