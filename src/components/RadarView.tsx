import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Play, Send, ShieldAlert, XCircle } from 'lucide-react';
import type { BreakoutEvaluation, FocusListItem, MarketType } from '../types';

export interface RadarPrefill {
  symbol: string;
  market: MarketType;
  nameZh?: string;
  closePrice: number;
  pivot: number;
  stopLoss: number;
  volMa50: number;
}

interface RadarViewProps {
  market: MarketType;
  focusList: FocusListItem[];
  prefill: RadarPrefill | null;
}

function formatSessionStatusZh(status: string): string {
  switch (status) {
    case 'PRE_MARKET':
      return '盤前階段';
    case 'DELAY_WINDOW':
      return '開盤延遲保護窗';
    case 'INTRADAY':
      return '盤中交易時段';
    case 'POST_MARKET':
      return '盤後收盤';
    default:
      return status;
  }
}

export const RadarView: React.FC<RadarViewProps> = ({ market, focusList, prefill }) => {
  const [symbol, setSymbol] = useState(prefill?.symbol || (market === 'TW' ? '2330' : 'NVDA'));
  const [nameZh, setNameZh] = useState(prefill?.nameZh || '');
  const [lastPrice, setLastPrice] = useState(
    prefill ? String(Number((prefill.pivot * 1.003).toFixed(2))) : market === 'TW' ? '1065' : '142.5'
  );
  const [pivot, setPivot] = useState(prefill ? String(prefill.pivot) : market === 'TW' ? '1060' : '141.8');
  const [stopLoss, setStopLoss] = useState(prefill ? String(prefill.stopLoss) : market === 'TW' ? '1005' : '134.2');
  const [volMa50Shares, setVolMa50Shares] = useState(
    prefill ? String(prefill.volMa50) : market === 'TW' ? '32000000' : '45000000'
  );
  const [cumVolUnits, setCumVolUnits] = useState(market === 'TW' ? '18000' : '24000000');
  const [simTime, setSimTime] = useState(market === 'TW' ? '10:30' : '11:30');
  const [volMultiplier, setVolMultiplier] = useState('1.5');
  const [accountEquity, setAccountEquity] = useState(market === 'TW' ? '2000000' : '100000');
  const [riskPct, setRiskPct] = useState('1.0');
  const [allowOddLot, setAllowOddLot] = useState(false);

  const [evaluation, setEvaluation] = useState<BreakoutEvaluation | null>(null);
  const [telegramPreview, setTelegramPreview] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushStatus, setPushStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (prefill) {
      setSymbol(prefill.symbol);
      setNameZh(prefill.nameZh || '');
      setPivot(String(prefill.pivot));
      setStopLoss(String(prefill.stopLoss));
      setLastPrice(String(Number((prefill.pivot * 1.004).toFixed(2))));
      setVolMa50Shares(String(prefill.volMa50 || 1000000));
      const approxHalfDayUnits =
        prefill.market === 'TW'
          ? Math.round((prefill.volMa50 * 0.55) / 1000)
          : Math.round(prefill.volMa50 * 0.55);
      setCumVolUnits(String(Math.max(100, approxHalfDayUnits)));
      setSimTime(prefill.market === 'TW' ? '10:30' : '11:30');
      setAccountEquity(prefill.market === 'TW' ? '2000000' : '100000');
    }
  }, [prefill]);

  const runEvaluation = async () => {
    setLoading(true);
    setError(null);
    setPushStatus(null);
    try {
      const resp = await fetch('/api/radar/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          market,
          nameZh,
          lastPrice: Number(lastPrice),
          cumVolUnits: Number(cumVolUnits),
          suggestedPivot: Number(pivot),
          suggestedStopLoss: Number(stopLoss),
          volMa50Shares: Number(volMa50Shares),
          simulatedTimeHHMM: simTime,
          volMultiplier: Number(volMultiplier),
          accountEquity: Number(accountEquity),
          riskPct: Number(riskPct),
          allowOddLot,
        }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || '突破試算失敗');
      setEvaluation(json.evaluation);
      setTelegramPreview(json.telegram_preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : '盤中突破條件試算失敗');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runEvaluation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, prefill]);

  const handleLoadFocusItem = (item: FocusListItem) => {
    setSymbol(item.symbol);
    setNameZh(item.name_zh || '');
    setPivot(String(item.suggested_pivot));
    setStopLoss(String(item.suggested_stop_loss));
    setLastPrice(String(Number((item.suggested_pivot * 1.003).toFixed(2))));
    setVolMa50Shares(String(item.vol_ma50 || 1000000));
    const units =
      market === 'TW' ? Math.round((item.vol_ma50 * 0.55) / 1000) : Math.round(item.vol_ma50 * 0.55);
    setCumVolUnits(String(Math.max(100, units)));
  };

  const handleSendAlert = async () => {
    if (!telegramPreview) return;
    setPushStatus(null);
    try {
      const resp = await fetch('/api/telegram/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: telegramPreview }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || 'Telegram 推播失敗');
      setPushStatus({ ok: true, msg: `突破警報已成功推播至 ${json.targets} 個聊天室。` });
    } catch (err) {
      setPushStatus({ ok: false, msg: err instanceof Error ? err.message : '推播失敗' });
    }
  };

  const marketLabel = market === 'TW' ? '台股' : '美股';
  const currency = market === 'TW' ? 'TWD' : 'USD';
  const volUnitLabel = market === 'TW' ? '盤中累積成交量（張）' : '盤中累積成交量（股）';

  return (
    <div className="space-y-6">
      <div className="pb-5 border-b border-slate-200">
        <h1 className="text-2xl font-display font-bold tracking-tight text-slate-900">
          盤中樞紐突破雷達與 1% 風控部位試算
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          雙重突破條件即時驗證（即時價 ≥ 樞紐價 且 預估全日成交量 ≥ 1.5 倍 50 日均量），內建{market === 'TW' ? '台股開盤前 5 分鐘' : '美股開盤前 15 分鐘'}量能雜訊保護窗與單筆 1% 帳戶風控股數試算。
        </p>
      </div>

      {/* Quick Load From Focus List */}
      {focusList.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className="font-medium">從{marketLabel} Focus List 快速載入：</span>
          {focusList.slice(0, 10).map((item) => (
            <button
              key={item.symbol}
              type="button"
              onClick={() => handleLoadFocusItem(item)}
              className={`px-2.5 py-1 font-mono rounded border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                symbol === item.symbol
                  ? 'border-blue-700 text-blue-700 bg-blue-50/50 font-semibold'
                  : 'border-slate-200 text-slate-700 hover:border-slate-400'
              }`}
            >
              {item.symbol} {item.name_zh || ''}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Simulation & Risk Inputs */}
        <div className="lg:col-span-5 border border-slate-200 rounded-lg p-5 bg-white space-y-4">
          <h2 className="text-sm font-display font-semibold text-slate-900 pb-3 border-b border-slate-200">
            盤中報價模擬與風控參數（{marketLabel}）
          </h2>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs">
              <span className="text-slate-600">股票代號</span>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                className="mt-1 w-full px-3 py-2 font-mono text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-600">
                盤中時間（{market === 'TW' ? '09:00–13:30' : '09:30–16:00'}）
              </span>
              <input
                type="time"
                value={simTime}
                onChange={(e) => setSimTime(e.target.value)}
                className="mt-1 w-full px-3 py-2 font-mono text-xs border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </label>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <label className="block text-xs">
              <span className="text-slate-600">盤中即時價</span>
              <input
                type="number"
                step="0.01"
                value={lastPrice}
                onChange={(e) => setLastPrice(e.target.value)}
                className="mt-1 w-full px-3 py-2 font-mono text-xs border border-slate-300 rounded-md"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-600">樞紐突破價</span>
              <input
                type="number"
                step="0.01"
                value={pivot}
                onChange={(e) => setPivot(e.target.value)}
                className="mt-1 w-full px-3 py-2 font-mono text-xs border border-slate-300 rounded-md"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-600">預設停損價</span>
              <input
                type="number"
                step="0.01"
                value={stopLoss}
                onChange={(e) => setStopLoss(e.target.value)}
                className="mt-1 w-full px-3 py-2 font-mono text-xs border border-slate-300 rounded-md"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs">
              <span className="text-slate-600">{volUnitLabel}</span>
              <input
                type="number"
                value={cumVolUnits}
                onChange={(e) => setCumVolUnits(e.target.value)}
                className="mt-1 w-full px-3 py-2 font-mono text-xs border border-slate-300 rounded-md"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-600">50 日均量（股數）</span>
              <input
                type="number"
                value={volMa50Shares}
                onChange={(e) => setVolMa50Shares(e.target.value)}
                className="mt-1 w-full px-3 py-2 font-mono text-xs border border-slate-300 rounded-md"
              />
            </label>
          </div>

          <div className="grid grid-cols-3 gap-3 pt-2 border-t border-slate-100">
            <label className="block text-xs">
              <span className="text-slate-600">帳戶總資金 ({currency})</span>
              <input
                type="number"
                value={accountEquity}
                onChange={(e) => setAccountEquity(e.target.value)}
                className="mt-1 w-full px-3 py-2 font-mono text-xs border border-slate-300 rounded-md"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-600">單筆風險 (%)</span>
              <input
                type="number"
                step="0.1"
                value={riskPct}
                onChange={(e) => setRiskPct(e.target.value)}
                className="mt-1 w-full px-3 py-2 font-mono text-xs border border-slate-300 rounded-md"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-600">量能倍數門檻</span>
              <input
                type="number"
                step="0.1"
                value={volMultiplier}
                onChange={(e) => setVolMultiplier(e.target.value)}
                className="mt-1 w-full px-3 py-2 font-mono text-xs border border-slate-300 rounded-md"
              />
            </label>
          </div>

          {market === 'TW' && (
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={allowOddLot}
                onChange={(e) => setAllowOddLot(e.target.checked)}
                className="rounded border-slate-300"
              />
              <span>允許台股零股交易（以 1 股為單位取整，而非 1,000 股整張）</span>
            </label>
          )}

          <button
            type="button"
            disabled={loading}
            onClick={runEvaluation}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            {loading ? '試算中...' : '檢核雙重突破條件與部位股數'}
          </button>

          {error && <p className="text-xs text-rose-700">{error}</p>}
        </div>

        {/* Right: Evaluation Output & Telegram Alert Card */}
        <div className="lg:col-span-7 space-y-6">
          {evaluation && (
            <>
              <div className="border border-slate-200 rounded-lg p-5 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200">
                  <div>
                    <div className="text-xs text-slate-500">
                      雙重突破觸發狀態 · {formatSessionStatusZh(evaluation.volume_estimate.status)}（{evaluation.volume_estimate.as_of}）
                    </div>
                    <div
                      className={`mt-1 text-xl font-display font-bold inline-flex items-center gap-2 ${
                        evaluation.triggered ? 'text-emerald-700' : 'text-slate-900'
                      }`}
                    >
                      {evaluation.triggered ? (
                        <>
                          <CheckCircle2 className="w-5 h-5" />
                          突破訊號觸發（符合進場條件）
                        </>
                      ) : (
                        <>
                          <XCircle className="w-5 h-5 text-slate-400" />
                          待機觀望 — 條件尚未同時達標
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-right font-mono text-xs text-slate-600 tabular-nums">
                    <div>開盤已經過：{evaluation.volume_estimate.elapsed_minutes} 分鐘</div>
                    <div>
                      全日推估係數：
                      {evaluation.volume_estimate.scale_factor !== null
                        ? `${evaluation.volume_estimate.scale_factor}×`
                        : '延遲保護／非盤中'}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
                  <div className="p-4 border border-slate-200 rounded-md bg-slate-50/50">
                    <div className="text-xs text-slate-500">條件 1 · 即時價 ≥ 樞紐價</div>
                    <div
                      className={`mt-1 text-base font-mono font-semibold tabular-nums ${
                        evaluation.price_triggered ? 'text-emerald-700' : 'text-rose-700'
                      }`}
                    >
                      {evaluation.last_price.toFixed(2)} vs {evaluation.suggested_pivot.toFixed(2)} ·{' '}
                      {evaluation.price_triggered ? '達標' : '未達標'}
                    </div>
                  </div>

                  <div className="p-4 border border-slate-200 rounded-md bg-slate-50/50">
                    <div className="text-xs text-slate-500">
                      條件 2 · 預估全日量 ≥ {volMultiplier}× 50 日均量
                    </div>
                    <div
                      className={`mt-1 text-base font-mono font-semibold tabular-nums ${
                        evaluation.volume_triggered ? 'text-emerald-700' : 'text-rose-700'
                      }`}
                    >
                      {evaluation.est_vol_ratio_50d !== null
                        ? `${evaluation.est_vol_ratio_50d.toFixed(2)}× · ${evaluation.volume_triggered ? '達標' : '量能不足'}`
                        : '開盤保護窗暫緩'}
                    </div>
                    <div className="mt-0.5 text-[11px] font-mono text-slate-500 tabular-nums">
                      預估 {evaluation.volume_estimate.estimated_vol_shares?.toLocaleString() ?? '—'} / 均量{' '}
                      {evaluation.vol_ma50_shares.toLocaleString()} 股
                    </div>
                  </div>
                </div>
              </div>

              {/* 1% Risk Position Sizing */}
              {evaluation.position_sizing && (
                <div className="border border-slate-200 rounded-lg p-5 bg-white">
                  <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200">
                    <h3 className="text-sm font-display font-semibold text-slate-900">
                      單筆 1% 風控部位試算（{currency}）
                    </h3>
                    {evaluation.position_sizing.exceeds_max_stop_cap && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-700">
                        <ShieldAlert className="w-3.5 h-3.5" />
                        停損幅度超過 8.0% 硬上限
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div>
                      <div className="text-xs text-slate-500">建議買進部位</div>
                      <div className="mt-1 text-lg font-mono font-bold text-slate-900 tabular-nums">
                        {evaluation.position_sizing.suggested_shares.toLocaleString()} 股
                      </div>
                      {evaluation.position_sizing.suggested_lots !== null && (
                        <div className="text-[11px] font-mono text-slate-500">
                          約 {evaluation.position_sizing.suggested_lots} 張
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">預估投入市值</div>
                      <div className="mt-1 text-lg font-mono font-semibold text-slate-900 tabular-nums">
                        {evaluation.position_sizing.position_value.toLocaleString()}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500">
                        佔總資金 {evaluation.position_sizing.position_weight_pct}%
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">實際承擔風險</div>
                      <div className="mt-1 text-lg font-mono font-semibold text-rose-700 tabular-nums">
                        {evaluation.position_sizing.actual_risk_amount.toLocaleString()}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500">
                        風險上限 {evaluation.position_sizing.max_risk_amount.toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-500">停損幅度</div>
                      <div className="mt-1 text-lg font-mono font-semibold text-slate-900 tabular-nums">
                        {evaluation.position_sizing.stop_loss_pct.toFixed(2)}%
                      </div>
                      <div className="text-[11px] font-mono text-slate-500">
                        每股風險 {evaluation.position_sizing.risk_per_share.toFixed(2)}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Telegram Breakout Alert Card */}
              <div className="border border-slate-200 rounded-lg p-5 bg-white">
                <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-200">
                  <h3 className="text-sm font-display font-semibold text-slate-900">
                    Telegram 盤中突破警報推播預覽
                  </h3>
                  <button
                    type="button"
                    onClick={handleSendAlert}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    推播突破警報至 Telegram
                  </button>
                </div>
                <pre className="p-3.5 bg-slate-50 border border-slate-200 rounded-md text-xs font-mono whitespace-pre-wrap text-slate-800">
                  {telegramPreview}
                </pre>
                {pushStatus && (
                  <div
                    className={`mt-2.5 flex items-center gap-1.5 text-xs ${
                      pushStatus.ok ? 'text-emerald-700' : 'text-rose-700'
                    }`}
                  >
                    {pushStatus.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                    <span>{pushStatus.msg}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
