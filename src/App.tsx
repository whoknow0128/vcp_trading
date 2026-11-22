import React, { useEffect, useState } from 'react';
import { ConfigView } from './components/ConfigView';
import { type RadarPrefill, RadarView } from './components/RadarView';
import { ScannerView } from './components/ScannerView';
import { SingleStockView } from './components/SingleStockView';
import type { FocusListItem, MarketType, PostMarketScanReport } from './types';

type ActiveTab = 'scanner' | 'single' | 'radar' | 'config';

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('single');
  const [market, setMarket] = useState<MarketType>('US');

  const [reports, setReports] = useState<Record<MarketType, PostMarketScanReport | null>>({
    US: null,
    TW: null,
  });
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const [selectedSymbol, setSelectedSymbol] = useState<string | undefined>(undefined);
  const [radarPrefill, setRadarPrefill] = useState<RadarPrefill | null>(null);

  useEffect(() => {
    fetch(`/api/watchlist/${market}`)
      .then((r) => r.json())
      .then((data) => {
        if (data?.report) {
          setReports((prev) => ({ ...prev, [market]: data.report }));
        }
      })
      .catch(() => undefined);
  }, [market]);

  const handleRunScan = async (maxCandidates = 30) => {
    setActiveTab('scanner');
    setScanLoading(true);
    setScanError(null);
    try {
      const resp = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market, maxCandidates, focusMin: 5, focusMax: 15 }),
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || '盤後海選執行失敗');
      setReports((prev) => ({ ...prev, [market]: json.report }));
    } catch (err) {
      setScanError(err instanceof Error ? err.message : '無法完成盤後海選');
    } finally {
      setScanLoading(false);
    }
  };

  const handleSelectStock = (symbol: string, mkt: MarketType) => {
    setMarket(mkt);
    setSelectedSymbol(symbol);
    setActiveTab('single');
  };

  const handleSendItemToRadar = (item: FocusListItem) => {
    setRadarPrefill({
      symbol: item.symbol,
      market: item.metrics.meta.market,
      nameZh: item.name_zh,
      closePrice: item.close_price,
      pivot: item.suggested_pivot,
      stopLoss: item.suggested_stop_loss,
      volMa50: item.vol_ma50,
    });
    setActiveTab('radar');
  };

  const handleSendSingleToRadar = (payload: RadarPrefill) => {
    setRadarPrefill(payload);
    setActiveTab('radar');
  };

  const marketLabel = market === 'TW' ? '台股' : '美股';

  const navItems: Array<{ id: ActiveTab; label: string }> = [
    { id: 'single', label: '單股診斷' },
    { id: 'scanner', label: '盤後海選' },
    { id: 'radar', label: '突破雷達' },
    { id: 'config', label: '市場規範' },
  ];

  return (
    <div className="min-h-screen bg-white text-slate-900 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-[1360px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line Brand Wordmark */}
          <button
            type="button"
            onClick={() => setActiveTab('single')}
            className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
          >
            VCP 選股戰情室
          </button>

          {/* Zone 2: 4 Clean Single-Line Nav Links */}
          <nav className="flex items-center gap-6 overflow-x-auto" aria-label="主導覽列">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`text-sm font-medium pb-0.5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeTab === item.id
                    ? 'text-slate-900 border-blue-700'
                    : 'text-slate-500 border-transparent hover:text-slate-900'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Zone 3: Single Primary Action */}
          <div className="shrink-0">
            <button
              type="button"
              disabled={scanLoading}
              onClick={() => handleRunScan(30)}
              className="px-4 py-2 text-xs font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-60 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {scanLoading ? `${marketLabel}海選中...` : `執行${marketLabel}海選`}
            </button>
          </div>
        </div>
      </header>

      {/* Workspace Market Toolbar (Below Header) */}
      <div className="border-b border-slate-200 bg-slate-50/70">
        <div className="max-w-[1360px] mx-auto px-6 py-2.5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-slate-500">分析市場</span>
            <div className="flex items-center p-0.5 bg-slate-200/70 rounded-md">
              <button
                type="button"
                onClick={() => {
                  setMarket('US');
                  setSelectedSymbol(undefined);
                }}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  market === 'US'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                美股 · QQQ (50/150/200MA)
              </button>
              <button
                type="button"
                onClick={() => {
                  setMarket('TW');
                  setSelectedSymbol(undefined);
                }}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  market === 'TW'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                台股 · ^TWII (60/120/240MA)
              </button>
            </div>
          </div>

          <div className="text-xs text-slate-500">
            Mark Minervini SEPA × VCP · 還原權息日 K · 單筆 1% 風控紀律
          </div>
        </div>
      </div>

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-[1360px] w-full mx-auto px-6 py-7">
        {activeTab === 'single' && (
          <SingleStockView
            market={market}
            initialSymbol={selectedSymbol}
            onSendToRadar={handleSendSingleToRadar}
          />
        )}
        {activeTab === 'scanner' && (
          <ScannerView
            market={market}
            report={reports[market]}
            loading={scanLoading}
            error={scanError}
            onRunScan={handleRunScan}
            onSelectStock={handleSelectStock}
            onSendToRadar={handleSendItemToRadar}
          />
        )}
        {activeTab === 'radar' && (
          <RadarView
            market={market}
            focusList={reports[market]?.focus_list || []}
            prefill={radarPrefill}
          />
        )}
        {activeTab === 'config' && <ConfigView />}
      </main>
    </div>
  );
}

export default App;
