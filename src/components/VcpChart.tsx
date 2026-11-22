import React, { useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartSeriesPoint, MarketType } from '../types';

interface VcpChartProps {
  data: ChartSeriesPoint[];
  market: MarketType;
  symbol: string;
  benchmarkSymbol: string;
  pivot: number;
  stopLoss: number;
}

export const VcpChart: React.FC<VcpChartProps> = ({
  data,
  market,
  symbol,
  benchmarkSymbol,
  pivot,
  stopLoss,
}) => {
  const [rangeBars, setRangeBars] = useState<60 | 100 | 140>(100);
  const [showBollinger, setShowBollinger] = useState(true);
  const [subPanel, setSubPanel] = useState<'volume' | 'rs'>('volume');

  const maLabels = market === 'TW' ? { s: 'MA60', m: 'MA120', l: 'MA240' } : { s: 'MA50', m: 'MA150', l: 'MA200' };

  const visibleData = useMemo(() => data.slice(-rangeBars), [data, rangeBars]);

  const priceDomain = useMemo(() => {
    if (!visibleData.length) return [0, 100];
    let minVal = stopLoss;
    let maxVal = pivot;
    for (const d of visibleData) {
      if (d.low < minVal) minVal = d.low;
      if (d.high > maxVal) maxVal = d.high;
      if (showBollinger && d.bbLower !== null && d.bbLower < minVal) minVal = d.bbLower;
      if (showBollinger && d.bbUpper !== null && d.bbUpper > maxVal) maxVal = d.bbUpper;
    }
    const pad = (maxVal - minVal) * 0.06;
    return [Math.max(0, Number((minVal - pad).toFixed(2))), Number((maxVal + pad).toFixed(2))];
  }, [visibleData, pivot, stopLoss, showBollinger]);

  if (!visibleData.length) {
    return (
      <div className="h-80 flex items-center justify-center border border-slate-200 rounded-lg text-sm text-slate-500">
        目前無可用的圖表序列資料。
      </div>
    );
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5 border-b border-slate-200">
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span className="font-display font-semibold text-sm text-slate-900">
            {symbol} 還原日線與均線結構
          </span>
          <span aria-hidden="true" className="text-slate-300">
            ·
          </span>
          <span className="text-blue-700 font-medium">收盤價</span>
          <span className="text-amber-700">MA20</span>
          <span className="text-indigo-700">{maLabels.s}</span>
          <span className="text-slate-500">{maLabels.m}</span>
          <span className="text-slate-800">{maLabels.l}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowBollinger((v) => !v)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              showBollinger
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            布林通道 (20, 2σ)
          </button>

          <div className="flex items-center p-0.5 bg-slate-100 rounded-md">
            {([60, 100, 140] as const).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRangeBars(n)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  rangeBars === n
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {n}日
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Price + MA + BB + Pivot/Stop Chart */}
      <div className="px-4 pt-4 pb-2 h-[330px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={visibleData} margin={{ top: 10, right: 20, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: '#64748b' }}
              tickFormatter={(v: string) => v.slice(5)}
              minTickGap={28}
              axisLine={{ stroke: '#e2e8f0' }}
              tickLine={false}
            />
            <YAxis
              domain={priceDomain}
              orientation="right"
              tick={{ fontSize: 11, fill: '#64748b', fontFamily: 'JetBrains Mono' }}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#ffffff',
                borderColor: '#cbd5e1',
                borderRadius: '6px',
                fontSize: '12px',
                fontFamily: 'JetBrains Mono, Noto Sans TC, monospace',
              }}
              formatter={(value: any, name: string) => [
                typeof value === 'number' ? value.toFixed(2) : '-',
                name,
              ]}
            />

            {showBollinger && (
              <>
                <Line
                  type="monotone"
                  dataKey="bbUpper"
                  name="布林上軌"
                  stroke="#94a3b8"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="bbLower"
                  name="布林下軌"
                  stroke="#94a3b8"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  dot={false}
                  isAnimationActive={false}
                />
              </>
            )}

            <Line
              type="monotone"
              dataKey="ma20"
              name="MA20"
              stroke="#d97706"
              strokeWidth={1.25}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="maShort"
              name={maLabels.s}
              stroke="#4f46e5"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="maMid"
              name={maLabels.m}
              stroke="#64748b"
              strokeWidth={1.25}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="maLong"
              name={maLabels.l}
              stroke="#0f172a"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="close"
              name="還原收盤價"
              stroke="#1d4ed8"
              strokeWidth={2.2}
              dot={false}
              isAnimationActive={false}
            />

            <ReferenceLine
              y={pivot}
              stroke="#15803d"
              strokeDasharray="4 4"
              strokeWidth={1.25}
              label={{
                value: `樞紐價 ${pivot.toFixed(2)}`,
                position: 'insideTopLeft',
                fill: '#15803d',
                fontSize: 11,
                fontFamily: 'JetBrains Mono, Noto Sans TC',
              }}
            />
            <ReferenceLine
              y={stopLoss}
              stroke="#b91c1c"
              strokeDasharray="4 4"
              strokeWidth={1.25}
              label={{
                value: `停損價 ${stopLoss.toFixed(2)}`,
                position: 'insideBottomLeft',
                fill: '#b91c1c',
                fontSize: 11,
                fontFamily: 'JetBrains Mono, Noto Sans TC',
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Sub-Chart Switcher: Volume vs RS Line */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-2 border-t border-slate-100 bg-slate-50/70">
        <div className="flex items-center gap-1 p-0.5 bg-slate-200/70 rounded-md">
          <button
            type="button"
            onClick={() => setSubPanel('volume')}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              subPanel === 'volume' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            成交量與 50 日均量
          </button>
          <button
            type="button"
            onClick={() => setSubPanel('rs')}
            className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              subPanel === 'rs' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            RS 相對強度線 vs {benchmarkSymbol}
          </button>
        </div>
        <span className="text-xs text-slate-500">
          {subPanel === 'volume'
            ? '日成交量（柱狀）· 50 日均量（曲線）'
            : `相對強度比值（${symbol} / ${benchmarkSymbol}）· RS 50 日均線`}
        </span>
      </div>

      <div className="px-4 py-3 h-[155px]">
        <ResponsiveContainer width="100%" height="100%">
          {subPanel === 'volume' ? (
            <ComposedChart data={visibleData} margin={{ top: 6, right: 20, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: '#64748b' }}
                tickFormatter={(v: string) => v.slice(5)}
                minTickGap={28}
                axisLine={{ stroke: '#e2e8f0' }}
                tickLine={false}
              />
              <YAxis
                orientation="right"
                tick={{ fontSize: 10, fill: '#64748b', fontFamily: 'JetBrains Mono' }}
                tickFormatter={(v: number) =>
                  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}K` : String(v)
                }
                axisLine={false}
                tickLine={false}
                width={64}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#ffffff',
                  borderColor: '#cbd5e1',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontFamily: 'JetBrains Mono, Noto Sans TC, monospace',
                }}
                formatter={(value: any, name: string) => [
                  typeof value === 'number' ? value.toLocaleString() : '-',
                  name,
                ]}
              />
              <Bar dataKey="volume" name="日成交量" fill="#cbd5e1" isAnimationActive={false} />
              <Line
                type="monotone"
                dataKey="volMa50"
                name="50 日均量"
                stroke="#0f172a"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          ) : (
            <ComposedChart data={visibleData} margin={{ top: 6, right: 20, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: '#64748b' }}
                tickFormatter={(v: string) => v.slice(5)}
                minTickGap={28}
                axisLine={{ stroke: '#e2e8f0' }}
                tickLine={false}
              />
              <YAxis
                domain={['auto', 'auto']}
                orientation="right"
                tick={{ fontSize: 10, fill: '#64748b', fontFamily: 'JetBrains Mono' }}
                axisLine={false}
                tickLine={false}
                width={64}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#ffffff',
                  borderColor: '#cbd5e1',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontFamily: 'JetBrains Mono, Noto Sans TC, monospace',
                }}
              />
              <Line
                type="monotone"
                dataKey="rsLine"
                name="RS 相對強度線"
                stroke="#1d4ed8"
                strokeWidth={1.75}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="rsMa50"
                name="RS 50 日均線"
                stroke="#d97706"
                strokeWidth={1.25}
                strokeDasharray="3 3"
                dot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
};
