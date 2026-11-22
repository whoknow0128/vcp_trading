import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { SystemConfigResponse } from '../types';

function formatTrendZh(trend: string): string {
  if (trend === 'UPTREND') return '多頭順風';
  if (trend === 'MIXED') return '震盪分歧';
  if (trend === 'DOWNTREND') return '空頭逆風';
  return trend;
}

export const ConfigView: React.FC = () => {
  const [config, setConfig] = useState<SystemConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => setConfig(d))
      .catch(() => setConfig(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="border border-slate-200 rounded-lg p-12 text-center text-sm text-slate-500">
        正在載入市場參數與系統串接狀態...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="pb-5 border-b border-slate-200">
        <h1 className="text-2xl font-display font-bold tracking-tight text-slate-900">
          市場參數規範與系統交易鐵律
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          即時讀取自 <code className="text-slate-800">config/markets.yaml</code> 之台美股交易參數與後端資料源連線狀態。
        </p>
      </div>

      {/* Three Core Guardrails */}
      <div className="border border-slate-200 rounded-lg p-5 bg-white">
        <h2 className="text-sm font-display font-semibold text-slate-900 pb-3 mb-4 border-b border-slate-200">
          SEPA × VCP 三大核心開發鐵律
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs text-slate-600 leading-relaxed">
          <div>
            <div className="font-display font-semibold text-slate-900 mb-1">
              01. 確定性量化引擎運算
            </div>
            所有均線、RS 線、BBW 120 日百分位、ATR 比值、ADR%、極度量縮（VDU）與口袋支點，一律由核心量化引擎精算並輸出標準 JSON，杜絕估算誤差。
          </div>
          <div>
            <div className="font-display font-semibold text-slate-900 mb-1">
              02. 歷史數據必須還原權息
            </div>
            嚴格採用除權息還原係數（<code className="text-slate-800">adjclose / close</code>）計算歷史日 K，避免除息跳空造成均線排列與 VCP 結構破線誤判。
          </div>
          <div>
            <div className="font-display font-semibold text-slate-900 mb-1">
              03. 拒絕落後震盪指標
            </div>
            核心進場濾網嚴禁引入 KD、RSI、MACD 等落後指標，一切以價格行為、成交量能收縮與放大、Stage 2 均線結構及波動率收斂為唯一準則。
          </div>
        </div>
      </div>

      {/* Market Parameters */}
      {config && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {(['US', 'TW'] as const).map((mkt) => {
            const c = config.markets?.[mkt] || {};
            const saved = config.saved_watchlists?.[mkt];
            return (
              <div key={mkt} className="border border-slate-200 rounded-lg p-5 bg-white">
                <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-200">
                  <h2 className="text-sm font-display font-semibold text-slate-900">
                    {mkt === 'US' ? '美股市場參數設定 (US)' : '台股市場參數設定 (TW)'}
                  </h2>
                  <span className="text-xs font-mono text-slate-500">
                    大盤基準 {c.benchmark || (mkt === 'US' ? 'QQQ' : '^TWII')}
                  </span>
                </div>
                <dl className="divide-y divide-slate-100 text-xs">
                  <div className="flex justify-between py-2">
                    <dt className="text-slate-500">Stage 2 均線樣板</dt>
                    <dd className="font-mono text-slate-900">
                      {c.ma ? `${c.ma.short} / ${c.ma.mid} / ${c.ma.long} MA` : mkt === 'US' ? '50 / 150 / 200 MA' : '60 / 120 / 240 MA'}
                    </dd>
                  </div>
                  <div className="flex justify-between py-2">
                    <dt className="text-slate-500">盤中開盤預估量延遲窗</dt>
                    <dd className="font-mono text-slate-900">
                      {c.intraday_volume_estimate_delay_minutes ?? (mkt === 'US' ? 15 : 5)} 分鐘
                    </dd>
                  </div>
                  <div className="flex justify-between py-2">
                    <dt className="text-slate-500">單筆交易帳戶風險比例</dt>
                    <dd className="font-mono text-slate-900">{c.risk?.account_risk_per_trade_pct ?? 1.0}%</dd>
                  </div>
                  <div className="flex justify-between py-2">
                    <dt className="text-slate-500">單筆最大停損硬上限</dt>
                    <dd className="font-mono text-slate-900">{c.risk?.max_stop_loss_pct ?? 8.0}%</dd>
                  </div>
                  <div className="flex justify-between py-2">
                    <dt className="text-slate-500">目前快取 Focus List</dt>
                    <dd className="font-mono text-slate-900">
                      {saved
                        ? `${saved.focus_count} 檔（${formatTrendZh(saved.benchmark_trend)}）`
                        : '尚未執行盤後掃描'}
                    </dd>
                  </div>
                </dl>
              </div>
            );
          })}
        </div>
      )}

      {/* Server-side Integrations */}
      {config && (
        <div className="border border-slate-200 rounded-lg p-5 bg-white">
          <h2 className="text-sm font-display font-semibold text-slate-900 pb-3 mb-3 border-b border-slate-200">
            外部資料源與通知串接狀態
          </h2>
          <div className="divide-y divide-slate-100 text-xs">
            <div className="flex items-center justify-between py-2.5">
              <div>
                <div className="font-medium text-slate-900">TradingView Stage 2 全市場海選引擎</div>
                <div className="text-slate-500">透過 HTTPS 執行美股與台股 Stage 2 初篩與財報日查詢</div>
              </div>
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
                <CheckCircle2 className="w-3.5 h-3.5" /> 運作中
              </span>
            </div>

            <div className="flex items-center justify-between py-2.5">
              <div>
                <div className="font-medium text-slate-900">Yahoo Finance v8 還原權息歷史日 K</div>
                <div className="text-slate-500">自動計算 adjclose / close 除權息還原係數</div>
              </div>
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
                <CheckCircle2 className="w-3.5 h-3.5" /> 運作中
              </span>
            </div>

            <div className="flex items-center justify-between py-2.5">
              <div>
                <div className="font-medium text-slate-900">證交所 TWSE & 櫃買中心 TPEx 籌碼介面</div>
                <div className="text-slate-500">抓取三大法人買賣超（T86）、融資融券、月營收年增率，並自動排除興櫃（OES）</div>
              </div>
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
                <CheckCircle2 className="w-3.5 h-3.5" /> 運作中
              </span>
            </div>

            <div className="flex items-center justify-between py-2.5">
              <div>
                <div className="font-medium text-slate-900">Telegram Bot 盤後與盤中推播</div>
                <div className="text-slate-500">
                  由後端環境變數 TG_BOT_TOKEN 與 TG_CHAT_ID 控制（金鑰絕不暴露於前端）
                </div>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 font-medium ${
                  config.integrations.telegram.configured ? 'text-emerald-700' : 'text-slate-500'
                }`}
              >
                {config.integrations.telegram.configured ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" /> 已設定（{config.integrations.telegram.chat_count} 個聊天室）
                  </>
                ) : (
                  <>
                    <XCircle className="w-3.5 h-3.5" /> 僅預覽（尚未設定環境變數）
                  </>
                )}
              </span>
            </div>

            <div className="flex items-center justify-between py-2.5">
              <div>
                <div className="font-medium text-slate-900">永豐 Shioaji / 富途 FutuOpenD 本機即時串流</div>
                <div className="text-slate-500">{config.integrations.shioaji.note}</div>
              </div>
              <span className="text-slate-500">雷達模擬模式</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
