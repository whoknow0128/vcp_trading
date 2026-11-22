import type {
  BreakoutEvaluation,
  ChartSeriesPoint,
  MarketConfig,
  MarketType,
  OhlcvBar,
  PositionSizingResult,
  VcpMetricsResult,
  VolumeEstimate,
} from './types.ts';

export const MARKET_CONFIGS: Record<MarketType, MarketConfig> = {
  US: {
    market: 'US',
    maShort: 50,
    maMid: 150,
    maLong: 200,
    benchmarkSymbol: 'QQQ',
    maModeLabel: '50_150_200',
    earningsWarningDays: 7,
    intradayDelayMinutes: 15,
    maxStopLossPct: 8.0,
    accountRiskPerTradePct: 1.0,
  },
  TW: {
    market: 'TW',
    maShort: 60,
    maMid: 120,
    maLong: 240,
    benchmarkSymbol: '^TWII',
    maModeLabel: '60_120_240',
    earningsWarningDays: 7,
    intradayDelayMinutes: 5,
    maxStopLossPct: 8.0,
    accountRiskPerTradePct: 1.0,
  },
};

export const TIER_PRIORITY: Record<string, number> = {
  S: 3,
  A: 2,
  B: 1,
  C: 0,
};

export const STATUS_PRIORITY: Record<string, number> = {
  BREAKOUT: 3,
  PIVOT_READY: 2,
  CONSOLIDATING: 1,
  EXTENDED: 0,
  NONE: 0,
};

export const GRADE_PRIORITY: Record<string, number> = {
  A_CANDIDATE: 4,
  B_WATCHLIST: 3,
  B_EARNINGS_WARNING: 2,
  B_OR_C_REVIEW: 2,
  C_EARNINGS_WARNING: 1,
  C: 0,
};

export const EARNINGS_DOWNGRADE: Record<string, string> = {
  A_CANDIDATE: 'B_EARNINGS_WARNING',
  B_WATCHLIST: 'C_EARNINGS_WARNING',
  B_OR_C_REVIEW: 'C_EARNINGS_WARNING',
};

function round(val: number, digits = 2): number {
  const factor = Math.pow(10, digits);
  return Math.round((val + Number.EPSILON) * factor) / factor;
}

function windowRangePct(bars: OhlcvBar[]): number {
  if (bars.length === 0) return 0.0;
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of bars) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  if (hi <= 0 || !Number.isFinite(hi) || !Number.isFinite(lo)) return 0.0;
  return round(((hi - lo) / hi) * 100.0, 2);
}

export function normalizeOhlcv(bars: OhlcvBar[]): OhlcvBar[] {
  const byDate = new Map<string, OhlcvBar>();
  for (const row of bars) {
    const date = String(row.date || '').slice(0, 10);
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    const volume = Number(row.volume);
    if (
      !date ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume) ||
      close <= 0
    ) {
      continue;
    }
    byDate.set(date, { date, open, high, low, close, volume: Math.max(0, volume) });
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function rollingMean(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) {
      sum -= values[i - period];
    }
    if (i >= period - 1) {
      out[i] = sum / period;
    }
  }
  return out;
}

function rollingStdPop(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const mean = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - mean;
      sq += d * d;
    }
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

function calcAtr(bars: OhlcvBar[], period: number): (number | null)[] {
  const tr: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const hl = bars[i].high - bars[i].low;
    if (i === 0) {
      tr[i] = hl;
    } else {
      const prevClose = bars[i - 1].close;
      tr[i] = Math.max(hl, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose));
    }
  }
  return rollingMean(tr, period);
}

function detectPocketPivot(bars: OhlcvBar[], lookbackDays = 5): boolean {
  if (bars.length < 15) return false;
  const downVol: number[] = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].close < bars[i - 1].close) {
      downVol[i] = bars[i].volume;
    }
  }
  const start = Math.max(1, bars.length - lookbackDays);
  for (let i = start; i < bars.length; i++) {
    const isUpDay = bars[i].close > bars[i - 1].close;
    if (!isUpDay) continue;
    let maxPrev10Down = 0;
    const winStart = Math.max(0, i - 10);
    for (let j = winStart; j < i; j++) {
      if (downVol[j] > maxPrev10Down) maxPrev10Down = downVol[j];
    }
    if (maxPrev10Down > 0 && bars[i].volume > maxPrev10Down) {
      return true;
    }
  }
  return false;
}

function countDistributionDays(bars: OhlcvBar[], window = 10): number {
  if (bars.length < 55) return 0;
  const vols = bars.map((b) => b.volume);
  const volMa50 = rollingMean(vols, 50);
  let count = 0;
  const start = Math.max(1, bars.length - window);
  for (let i = start; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    const pctChg = prevClose > 0 ? (bars[i].close - prevClose) / prevClose : 0;
    const v50 = volMa50[i];
    if (v50 !== null && pctChg <= -0.002 && bars[i].volume > bars[i - 1].volume && bars[i].volume > v50) {
      count += 1;
    }
  }
  return count;
}

export function calculateVcpMetrics(
  symbol: string,
  rawStockBars: OhlcvBar[],
  rawBenchmarkBars: OhlcvBar[],
  market: MarketType = 'US',
  catalysts?: Record<string, any> | null
): { metrics: VcpMetricsResult; chart: ChartSeriesPoint[]; volMa50: number } {
  const cfg = MARKET_CONFIGS[market];
  const df = normalizeOhlcv(rawStockBars);
  const bm = normalizeOhlcv(rawBenchmarkBars);

  const minBars = cfg.maLong + 25;
  if (df.length < minBars) {
    throw new Error(
      `歷史 K 棒不足（目前 ${df.length} 根，至少需要 ${minBars} 根以計算 ${cfg.maLong}MA 趨勢）`
    );
  }
  if (bm.length < 200) {
    throw new Error(`大盤基準 ${cfg.benchmarkSymbol} 歷史 K 棒不足（目前 ${bm.length} 根，至少需要 200 根）`);
  }

  const closes = df.map((b) => b.close);
  const volumes = df.map((b) => b.volume);
  const ma10 = rollingMean(closes, 10);
  const ma20 = rollingMean(closes, 20);
  const maShort = rollingMean(closes, cfg.maShort);
  const maMid = rollingMean(closes, cfg.maMid);
  const maLong = rollingMean(closes, cfg.maLong);
  const volMa50Series = rollingMean(volumes, 50);

  const lastIdx = df.length - 1;
  const latest = df[lastIdx];
  const closePrice = latest.close;

  // 52W High / Low (last 252 trading bars)
  const slice252 = df.slice(-252);
  let high52w = -Infinity;
  let low52w = Infinity;
  for (const b of slice252) {
    if (b.high > high52w) high52w = b.high;
    if (b.low < low52w) low52w = b.low;
  }
  const pctFrom52wHigh = (closePrice / high52w - 1.0) * 100.0;
  const pctFrom52wLow = (closePrice / low52w - 1.0) * 100.0;

  const latestMaShort = maShort[lastIdx] as number;
  const latestMaMid = maMid[lastIdx] as number;
  const latestMaLong = maLong[lastIdx] as number;
  const prev1mMaLong = maLong[lastIdx - 20] as number;
  const maLongRising1m = latestMaLong > prev1mMaLong;

  const stage2Pass =
    closePrice > latestMaShort &&
    latestMaShort > latestMaMid &&
    latestMaMid > latestMaLong &&
    maLongRising1m &&
    pctFrom52wLow >= 25.0 &&
    pctFrom52wHigh >= -25.0;

  // Gate 1: Benchmark trend
  const bmCloses = bm.map((b) => b.close);
  const bmMa50 = rollingMean(bmCloses, 50);
  const bmMa200 = rollingMean(bmCloses, 200);
  const bmLastIdx = bm.length - 1;
  const bmAbove50 = bmCloses[bmLastIdx] > (bmMa50[bmLastIdx] as number);
  const bmAbove200 = bmCloses[bmLastIdx] > (bmMa200[bmLastIdx] as number);
  const bmTrend: 'UPTREND' | 'MIXED' | 'DOWNTREND' =
    bmAbove50 && bmAbove200 ? 'UPTREND' : bmAbove200 ? 'MIXED' : 'DOWNTREND';

  // Relative Strength (RS Line) on inner-joined dates
  const bmByDate = new Map<string, number>();
  for (const b of bm) bmByDate.set(b.date, b.close);

  const mergedDates: string[] = [];
  const mergedRs: number[] = [];
  for (const b of df) {
    const bmC = bmByDate.get(b.date);
    if (bmC !== undefined && bmC > 0) {
      mergedDates.push(b.date);
      mergedRs.push(b.close / bmC);
    }
  }

  let rsLine52wHigh = false;
  let rsAboveMa50 = false;
  let rsRawScore = 0.0;
  const rsByDate = new Map<string, { rs: number; rsMa50: number | null }>();

  if (mergedRs.length >= 60) {
    const rsMa50Arr = rollingMean(mergedRs, 50);
    for (let i = 0; i < mergedDates.length; i++) {
      rsByDate.set(mergedDates[i], { rs: mergedRs[i], rsMa50: rsMa50Arr[i] });
    }
    const rsCurrent = mergedRs[mergedRs.length - 1];
    const recentRs252 = mergedRs.slice(-252);
    let rs52wMax = -Infinity;
    for (const v of recentRs252) if (v > rs52wMax) rs52wMax = v;
    rsLine52wHigh = rsCurrent >= rs52wMax * 0.995;
    const lastRsMa50 = rsMa50Arr[rsMa50Arr.length - 1];
    rsAboveMa50 = lastRsMa50 !== null && rsCurrent > lastRsMa50;

    const rsWindows: Array<[number, number]> = [
      [63, 0.4],
      [126, 0.2],
      [189, 0.2],
      [252, 0.2],
    ];
    let weightedSum = 0.0;
    let weightTotal = 0.0;
    for (const [lookback, weight] of rsWindows) {
      if (mergedRs.length > lookback) {
        const baseRs = mergedRs[mergedRs.length - (lookback + 1)];
        if (baseRs > 0) {
          weightedSum += (rsCurrent / baseRs - 1.0) * 100.0 * weight;
          weightTotal += weight;
        }
      }
    }
    rsRawScore = weightTotal > 0 ? round(weightedSum / weightTotal, 2) : 0.0;
  }

  // Gate 4: Bollinger Bands & BBW 120d percentile (as of T-1)
  const bbStd = rollingStdPop(closes, 20);
  const bbUpper: (number | null)[] = new Array(df.length).fill(null);
  const bbLower: (number | null)[] = new Array(df.length).fill(null);
  const bbwSeries: (number | null)[] = new Array(df.length).fill(null);
  for (let i = 0; i < df.length; i++) {
    const mid = ma20[i];
    const std = bbStd[i];
    if (mid !== null && std !== null && mid > 0) {
      const up = mid + 2.0 * std;
      const lo = mid - 2.0 * std;
      bbUpper[i] = up;
      bbLower[i] = lo;
      bbwSeries[i] = ((up - lo) / mid) * 100.0;
    }
  }

  const bbwT1Series = bbwSeries.slice(0, -1);
  const bbwCurrent = (bbwT1Series[bbwT1Series.length - 1] ?? 0) as number;
  const bbw120 = bbwT1Series.slice(-120).filter((v): v is number => v !== null);
  const bbw120dPercentile =
    bbw120.length > 0 ? (bbw120.filter((v) => v <= bbwCurrent).length / bbw120.length) * 100.0 : 50.0;
  const priceAboveBbMid = closePrice >= (ma20[lastIdx] as number);

  // ADR% (20d) & ATR(5)/ATR(20) (as of T-1) & ATR14% 60d percentile
  const dailyRangePct = df.map((b) => (b.low > 0 ? (b.high - b.low) / b.low : 0));
  const adrSeries = rollingMean(dailyRangePct, 20);
  const adr20dPct = ((adrSeries[lastIdx] ?? 0) as number) * 100.0;

  const atr5Series = calcAtr(df, 5);
  const atr20Series = calcAtr(df, 20);
  const atr5T1 = (atr5Series[lastIdx - 1] ?? 0) as number;
  const atr20T1 = (atr20Series[lastIdx - 1] ?? 0) as number;
  const atr520Ratio = atr20T1 > 0 ? round(atr5T1 / atr20T1, 3) : 1.0;
  const atr20 = (atr20Series[lastIdx] ?? 0) as number;

  const atr14Series = calcAtr(df, 14);
  const atr14PctSeries = atr14Series
    .slice(0, -1)
    .map((a, idx) => (a !== null && df[idx].close > 0 ? (a / df[idx].close) * 100.0 : null))
    .filter((v): v is number => v !== null);
  let atr14PctCurrent = 0.0;
  let atr14Pct60dPercentile = 50.0;
  if (atr14PctSeries.length > 0) {
    const curAtr14Pct = atr14PctSeries[atr14PctSeries.length - 1];
    atr14PctCurrent = round(curAtr14Pct, 2);
    const atr14_60d = atr14PctSeries.slice(-60);
    atr14Pct60dPercentile = round(
      (atr14_60d.filter((v) => v <= curAtr14Pct).length / atr14_60d.length) * 100.0,
      2
    );
  }
  const atr14Low60d = atr14Pct60dPercentile <= 25.0;

  const latestMa10 = ma10[lastIdx] as number;
  const distFrom10maInAtr = atr20 > 0 ? round((closePrice - latestMa10) / atr20, 2) : 0.0;

  // Volume-Price Action (VDU 3D & 5D T-1, Pocket Pivot, Distribution Days)
  const volMa50 = (volMa50Series[lastIdx] ?? 0) as number;
  const volRatio50d = volMa50 > 0 ? round(latest.volume / volMa50, 2) : 1.0;
  const recent3dVolAvg =
    (df[lastIdx].volume + df[lastIdx - 1].volume + df[lastIdx - 2].volume) / 3.0;
  const isVdu3d = volMa50 > 0 && recent3dVolAvg < volMa50 * 0.7;

  const volSlice5T1 = df.slice(-6, -1);
  const volMa5T1 =
    volSlice5T1.length > 0 ? volSlice5T1.reduce((acc, b) => acc + b.volume, 0) / volSlice5T1.length : 0;
  const volSlice50T1 = df.length >= 51 ? df.slice(-51, -1) : null;
  const volMa50T1 =
    volSlice50T1 && volSlice50T1.length > 0
      ? volSlice50T1.reduce((acc, b) => acc + b.volume, 0) / volSlice50T1.length
      : volMa50;
  const volMa5To50Ratio = volMa50T1 > 0 ? round(volMa5T1 / volMa50T1, 3) : 1.0;
  const isVdu5d = volMa50T1 > 0 && volMa5T1 < volMa50T1 * 0.6;

  const pocketPivotIn5d = detectPocketPivot(df, 5);
  const distDays10d = countDistributionDays(df, 10);

  // Right-side consolidation (as of T-1), Pivot, Stop-Loss & R:R
  const t1Df = df.slice(0, -1);
  const range40dPct = windowRangePct(t1Df.slice(-40));
  const range20dPct = windowRangePct(t1Df.slice(-20));
  const prior10dDf = t1Df.slice(-10);
  let prior10dHigh = -Infinity;
  let prior10dLow = Infinity;
  for (const b of prior10dDf) {
    if (b.high > prior10dHigh) prior10dHigh = b.high;
    if (b.low < prior10dLow) prior10dLow = b.low;
  }
  const tightness10dPct = windowRangePct(prior10dDf);
  const range10dPct = tightness10dPct;
  const range5dPct = windowRangePct(t1Df.slice(-5));
  const rangeContracting = range5dPct < range10dPct && range10dPct < range20dPct;
  const contractionSteps =
    (range5dPct < range10dPct ? 1 : 0) +
    (range10dPct < range20dPct ? 1 : 0) +
    (range20dPct < range40dPct ? 1 : 0);
  const range5dTight = range5dPct <= 8.0;

  const suggestedPivot = round(prior10dHigh * 1.002, 2);
  const hardStopFloor = suggestedPivot * 0.92;
  const suggestedStopLoss = round(Math.max(prior10dLow * 0.995, hardStopFloor), 2);
  const prior5dLow = Math.min(...t1Df.slice(-5).map((b) => b.low));
  const tightStop5dLow = round(Math.max(prior5dLow * 0.995, hardStopFloor), 2);
  const stopLossPct = round((suggestedStopLoss / suggestedPivot - 1.0) * 100.0, 2);
  const stopLossInAtr = atr20 > 0 ? round((suggestedPivot - suggestedStopLoss) / atr20, 2) : 0.0;
  const distToPivotPct = prior10dHigh > 0 ? round((closePrice / prior10dHigh - 1.0) * 100.0, 2) : 0.0;
  const riskPerShare = Math.max(0.01, suggestedPivot - suggestedStopLoss);
  const target2r = round(suggestedPivot + 2.0 * riskPerShare, 2);
  const target3r = round(suggestedPivot + 3.0 * riskPerShare, 2);

  // Setup status & Pre-filter Grade
  const dayHigh = latest.high;
  const dayLow = latest.low;
  const closingRange =
    dayHigh > dayLow
      ? round((closePrice - dayLow) / (dayHigh - dayLow), 4)
      : closePrice >= df[lastIdx - 1].close
        ? 1.0
        : 0.0;

  const isBreakoutBar = closePrice > prior10dHigh && volRatio50d >= 1.5 && closingRange >= 0.65;
  let setupStatus: 'BREAKOUT' | 'PIVOT_READY' | 'CONSOLIDATING' | 'EXTENDED' | 'NONE';
  if (!stage2Pass || distDays10d >= 3) {
    setupStatus = 'NONE';
  } else if (distFrom10maInAtr > 3.5) {
    setupStatus = 'EXTENDED';
  } else if (isBreakoutBar) {
    setupStatus = 'BREAKOUT';
  } else if (distToPivotPct >= -4.0 && distToPivotPct <= 0.0) {
    setupStatus = 'PIVOT_READY';
  } else {
    setupStatus = 'CONSOLIDATING';
  }

  const vcpTightPass =
    ((bbw120dPercentile <= 25.0 && atr520Ratio <= 0.75 && tightness10dPct <= 10.0) ||
      (rangeContracting && range5dTight && (atr14Low60d || atr520Ratio <= 0.75))) &&
    (isVdu3d || isVdu5d || pocketPivotIn5d);

  let preGrade: 'A_CANDIDATE' | 'B_WATCHLIST' | 'B_OR_C_REVIEW' | 'C';
  if (!stage2Pass || distDays10d >= 3 || distFrom10maInAtr > 3.5) {
    preGrade = 'C';
  } else if (vcpTightPass) {
    preGrade = isBreakoutBar ? 'A_CANDIDATE' : 'B_WATCHLIST';
  } else {
    preGrade = 'B_OR_C_REVIEW';
  }

  const metrics: VcpMetricsResult = {
    meta: {
      symbol,
      market,
      data_date: latest.date,
      close_price: round(closePrice, 2),
      benchmark_symbol: cfg.benchmarkSymbol,
      ma_mode: cfg.maModeLabel,
      pre_filter_grade: preGrade,
      setup_status: setupStatus,
    },
    gate1_market: {
      benchmark_above_50ma: bmAbove50,
      benchmark_above_200ma: bmAbove200,
      benchmark_trend: bmTrend,
    },
    gate2_trend_rs: {
      stage2_template_pass: stage2Pass,
      ma_values: {
        ma20: round(ma20[lastIdx] as number, 2),
        [`ma${cfg.maShort}`]: round(latestMaShort, 2),
        [`ma${cfg.maMid}`]: round(latestMaMid, 2),
        [`ma${cfg.maLong}`]: round(latestMaLong, 2),
      },
      ma_long_rising_1m: maLongRising1m,
      pct_from_52w_high: round(pctFrom52wHigh, 2),
      pct_from_52w_low: round(pctFrom52wLow, 2),
      rs_line_52w_high: rsLine52wHigh,
      rs_above_ma50: rsAboveMa50,
      rs_raw_score: rsRawScore,
    },
    gate3_catalysts: catalysts || { status: 'NOT_PROVIDED_REQUIRE_MANUAL_OR_ADAPTER' },
    gate4_setup_risk: {
      bbw_current_pct: round(bbwCurrent, 2),
      bbw_120d_percentile: round(bbw120dPercentile, 2),
      price_above_bb_mid: priceAboveBbMid,
      adr_20d_pct: round(adr20dPct, 2),
      atr_5_20_ratio: atr520Ratio,
      atr14_pct_current: atr14PctCurrent,
      atr14_pct_60d_percentile: atr14Pct60dPercentile,
      atr14_low_60d: atr14Low60d,
      tightness_10d_pct: tightness10dPct,
      range_40d_pct: range40dPct,
      range_20d_pct: range20dPct,
      range_10d_pct: range10dPct,
      range_5d_pct: range5dPct,
      range_contracting: rangeContracting,
      contraction_steps: contractionSteps,
      range_5d_tight: range5dTight,
      vol_ratio_50d: volRatio50d,
      vol_ma5_to_50_ratio: volMa5To50Ratio,
      closing_range: round(closingRange, 3),
      is_vdu_3d: isVdu3d,
      is_vdu_5d: isVdu5d,
      pocket_pivot_in_5d: pocketPivotIn5d,
      distribution_days_10d: distDays10d,
      dist_from_10ma_in_atr: distFrom10maInAtr,
      prior_10d_high: round(prior10dHigh, 2),
      prior_10d_low: round(prior10dLow, 2),
      prior_5d_low: round(prior5dLow, 2),
      recent_10d_high: round(prior10dHigh, 2),
      recent_10d_low: round(prior10dLow, 2),
      suggested_pivot: suggestedPivot,
      suggested_stop_loss: suggestedStopLoss,
      tight_stop_5d_low: tightStop5dLow,
      stop_loss_pct: stopLossPct,
      stop_loss_in_atr: stopLossInAtr,
      dist_to_pivot_pct: distToPivotPct,
      setup_status: setupStatus,
      target_2r: target2r,
      target_3r: target3r,
    },
  };

  // Build last 140 bars for interactive chart rendering
  const chartStart = Math.max(0, df.length - 140);
  const chart: ChartSeriesPoint[] = [];
  for (let i = chartStart; i < df.length; i++) {
    const b = df[i];
    const rsEntry = rsByDate.get(b.date);
    chart.push({
      date: b.date,
      open: round(b.open, 2),
      high: round(b.high, 2),
      low: round(b.low, 2),
      close: round(b.close, 2),
      volume: Math.round(b.volume),
      ma10: ma10[i] !== null ? round(ma10[i] as number, 2) : null,
      ma20: ma20[i] !== null ? round(ma20[i] as number, 2) : null,
      maShort: maShort[i] !== null ? round(maShort[i] as number, 2) : null,
      maMid: maMid[i] !== null ? round(maMid[i] as number, 2) : null,
      maLong: maLong[i] !== null ? round(maLong[i] as number, 2) : null,
      bbUpper: bbUpper[i] !== null ? round(bbUpper[i] as number, 2) : null,
      bbLower: bbLower[i] !== null ? round(bbLower[i] as number, 2) : null,
      bbw: bbwSeries[i] !== null ? round(bbwSeries[i] as number, 2) : null,
      volMa50: volMa50Series[i] !== null ? Math.round(volMa50Series[i] as number) : null,
      rsLine: rsEntry ? round(rsEntry.rs, 4) : null,
      rsMa50: rsEntry && rsEntry.rsMa50 !== null ? round(rsEntry.rsMa50, 4) : null,
    });
  }

  return { metrics, chart, volMa50: Math.round(volMa50) };
}

export function assignRsRatings(evaluated: Array<{ result: VcpMetricsResult }>): void {
  const n = evaluated.length;
  if (n === 0) return;
  if (n === 1) {
    evaluated[0].result.gate2_trend_rs.rs_rating = 99;
    return;
  }
  const ranked = [...evaluated].sort(
    (a, b) => Number(a.result.gate2_trend_rs.rs_raw_score ?? 0) - Number(b.result.gate2_trend_rs.rs_raw_score ?? 0)
  );
  ranked.forEach((item, idx) => {
    const rating = Math.max(1, Math.min(99, Math.round(1 + (idx / (n - 1)) * 98)));
    item.result.gate2_trend_rs.rs_rating = rating;
  });
}

function hasCatalystResonance(g3: Record<string, any>, market: MarketType): boolean {
  if (market === 'TW') {
    const inst = g3.institutional_10d_lots || g3.institutional_5d_lots || g3.institutional_1d_lots || {};
    if ((inst.trust || 0) > 0 || (inst.foreign || 0) > 0) return true;
    const revYoy = g3.monthly_revenue?.yoy_pct;
    return revYoy !== null && revYoy !== undefined && Number(revYoy) > 15.0;
  }
  const epsYoy = g3.eps_yoy_fq_pct;
  const revYoy = g3.revenue_yoy_fq_pct;
  return (
    (epsYoy !== null && epsYoy !== undefined && Number(epsYoy) > 15.0) ||
    (revYoy !== null && revYoy !== undefined && Number(revYoy) > 15.0)
  );
}

export function classifyVcpTier(
  res: VcpMetricsResult,
  market: MarketType,
  evaluatedCount: number,
  hasEarningsWarn: boolean
): 'S' | 'A' | 'B' | 'C' {
  const g2 = res.gate2_trend_rs;
  const g3 = res.gate3_catalysts || {};
  const g4 = res.gate4_setup_risk;

  if (
    !g2.stage2_template_pass ||
    Number(g4.distribution_days_10d ?? 0) >= 3 ||
    Number(g4.dist_from_10ma_in_atr ?? 0) > 3.5
  ) {
    return 'C';
  }

  const status = String(g4.setup_status || 'CONSOLIDATING');
  const steps = Number(g4.contraction_steps ?? 0);
  const tightVcp =
    Boolean(g4.range_contracting && g4.range_5d_tight) ||
    (Number(g4.bbw_120d_percentile ?? 100) <= 25.0 &&
      Number(g4.atr_5_20_ratio ?? 1.0) <= 0.75 &&
      Number(g4.tightness_10d_pct ?? 100) <= 10.0);
  const hasVdu = Boolean(g4.is_vdu_5d || g4.is_vdu_3d || g4.pocket_pivot_in_5d);
  const rsRating = g2.rs_rating;
  const rsOk = evaluatedCount < 4 || rsRating == null ? true : Number(rsRating) >= 75;
  const resonance = hasCatalystResonance(g3, market);

  if (
    !hasEarningsWarn &&
    rsOk &&
    (steps >= 2 || tightVcp) &&
    hasVdu &&
    resonance &&
    (status === 'BREAKOUT' || status === 'PIVOT_READY')
  ) {
    return 'S';
  }
  if (!hasEarningsWarn && (tightVcp || status === 'BREAKOUT' || status === 'PIVOT_READY') && (hasVdu || resonance)) {
    return 'A';
  }
  return 'B';
}

export function scoreCandidate(result: VcpMetricsResult, market: MarketType): number {
  const g2 = result.gate2_trend_rs;
  const g3 = result.gate3_catalysts || {};
  const g4 = result.gate4_setup_risk;

  let score = 0;
  if (g2.stage2_template_pass) score += 30;
  if (g2.rs_line_52w_high) score += 12;
  if (g2.rs_above_ma50) score += 6;

  if (g2.rs_rating != null) {
    if (Number(g2.rs_rating) >= 75) score += 10;
    else if (Number(g2.rs_rating) < 50) score -= 10;
  }

  const bbwPct = Number(g4.bbw_120d_percentile ?? 100);
  if (bbwPct <= 25.0) score += 12;
  else if (bbwPct <= 40.0) score += 5;

  const atrRatio = Number(g4.atr_5_20_ratio ?? 1.0);
  if (atrRatio <= 0.75) score += 10;
  else if (atrRatio <= 0.9) score += 4;

  if (g4.atr14_low_60d) score += 5;

  const tight = Number(g4.tightness_10d_pct ?? 100);
  if (tight <= 10.0) score += 6;
  else if (tight <= 15.0) score += 2;

  if (g4.range_contracting) score += 8;
  if (g4.range_5d_tight) score += 5;

  if (g4.is_vdu_5d) score += 6;
  else if (g4.is_vdu_3d || g4.pocket_pivot_in_5d) score += 4;

  if (g4.price_above_bb_mid) score += 4;

  const status = String(g4.setup_status || '');
  if (status === 'BREAKOUT') score += 12;
  else if (status === 'PIVOT_READY') score += 10;

  if (Number(g4.distribution_days_10d ?? 0) >= 3) score -= 15;
  if (Number(g4.dist_from_10ma_in_atr ?? 0) > 3.5) score -= 10;

  const adrPct = Number(g4.adr_20d_pct ?? 5.0);
  if (adrPct < 2.0) score -= 15;
  else if (adrPct > 10.0) score -= 10;

  if (market === 'TW') {
    const inst = g3.institutional_10d_lots || g3.institutional_5d_lots || g3.institutional_1d_lots || {};
    const trustNet = Number(inst.trust || 0);
    const foreignNet = Number(inst.foreign || 0);
    if (trustNet > 0 && foreignNet > 0) score += 6;
    else if (trustNet > 0 || foreignNet > 0) score += 4;
    const revYoy = g3.monthly_revenue?.yoy_pct;
    if (revYoy !== null && revYoy !== undefined && Number(revYoy) > 15.0) score += 4;
  } else {
    const epsYoy = g3.eps_yoy_fq_pct;
    const revYoy = g3.revenue_yoy_fq_pct;
    if (epsYoy !== null && epsYoy !== undefined && Number(epsYoy) > 15.0) score += 4;
    if (revYoy !== null && revYoy !== undefined && Number(revYoy) > 15.0) score += 4;
  }

  return Math.max(0, Math.min(100, score));
}

export function estimateFullDayVolume(
  market: MarketType,
  cumVolUnits: number,
  simulatedTimeHHMM: string
): VolumeEstimate {
  const isTw = market === 'TW';
  const sessionMinutes = isTw ? 270.0 : 390.0; // TW 09:00-13:30, US 09:30-16:00
  const openMinuteOfDay = isTw ? 9 * 60 : 9 * 60 + 30;
  const delayMinutes = isTw ? 5 : 15;
  const unitToShares = isTw ? 1000 : 1; // TW uses lots (張 = 1000 shares), US uses shares

  const parts = simulatedTimeHHMM.split(':').map((x) => Number(x));
  const hh = Number.isFinite(parts[0]) ? parts[0] : 10;
  const mm = Number.isFinite(parts[1]) ? parts[1] : 30;
  const elapsed = hh * 60 + mm - openMinuteOfDay;
  const cumShares = Math.round(cumVolUnits * unitToShares);

  let status: VolumeEstimate['status'];
  let scaleFactor: number | null = null;
  let estUnits: number | null = null;
  let estShares: number | null = null;

  if (elapsed <= 0) {
    status = 'PRE_MARKET';
  } else if (elapsed < delayMinutes) {
    status = 'DELAY_WINDOW';
  } else if (elapsed < sessionMinutes) {
    status = 'INTRADAY';
    const scale = sessionMinutes / elapsed;
    scaleFactor = round(scale, 4);
    estUnits = round(cumVolUnits * scale, 1);
    estShares = Math.round(estUnits * unitToShares);
  } else {
    status = 'POST_MARKET';
    scaleFactor = 1.0;
    estUnits = round(cumVolUnits, 1);
    estShares = Math.round(cumVolUnits * unitToShares);
  }

  return {
    status,
    as_of: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    elapsed_minutes: round(elapsed, 2),
    cum_vol_units: round(cumVolUnits, 1),
    cum_vol_shares: cumShares,
    scale_factor: scaleFactor,
    estimated_vol_units: estUnits,
    estimated_vol_shares: estShares,
  };
}

export function calculatePositionSize(params: {
  market: MarketType;
  accountEquity: number;
  riskPct: number;
  entryPrice: number;
  stopLossPrice: number;
  maxStopLossPct?: number;
  allowOddLot?: boolean;
}): PositionSizingResult {
  const {
    market,
    accountEquity,
    riskPct,
    entryPrice,
    stopLossPrice,
    maxStopLossPct = 8.0,
    allowOddLot = false,
  } = params;

  const maxRiskAmount = (accountEquity * riskPct) / 100.0;
  const riskPerShare = Math.max(0.0001, entryPrice - stopLossPrice);
  const stopLossPct = entryPrice > 0 ? round(((stopLossPrice / entryPrice) - 1.0) * 100.0, 2) : 0;
  const exceedsMaxStopCap = Math.abs(stopLossPct) > maxStopLossPct;

  const rawShares = entryPrice > stopLossPrice ? Math.floor(maxRiskAmount / riskPerShare) : 0;
  const maxAffordableShares = entryPrice > 0 ? Math.floor(accountEquity / entryPrice) : 0;
  const cappedShares = Math.min(rawShares, maxAffordableShares);

  let suggestedShares: number;
  let suggestedLots: number | null = null;
  if (market === 'TW' && !allowOddLot) {
    const lots = Math.floor(cappedShares / 1000);
    suggestedLots = lots;
    suggestedShares = lots * 1000;
  } else {
    suggestedShares = cappedShares;
    if (market === 'TW') {
      suggestedLots = round(suggestedShares / 1000, 3);
    }
  }

  const positionValue = round(suggestedShares * entryPrice, 2);
  const positionWeightPct = accountEquity > 0 ? round((positionValue / accountEquity) * 100.0, 2) : 0;
  const actualRiskAmount = round(suggestedShares * (entryPrice - stopLossPrice), 2);

  return {
    account_equity: accountEquity,
    risk_pct: riskPct,
    max_risk_amount: round(maxRiskAmount, 2),
    entry_price: round(entryPrice, 2),
    stop_loss_price: round(stopLossPrice, 2),
    risk_per_share: round(entryPrice - stopLossPrice, 2),
    stop_loss_pct: stopLossPct,
    exceeds_max_stop_cap: exceedsMaxStopCap,
    raw_shares: rawShares,
    suggested_shares: suggestedShares,
    suggested_lots: suggestedLots,
    position_value: positionValue,
    position_weight_pct: positionWeightPct,
    actual_risk_amount: actualRiskAmount,
  };
}

export function evaluateBreakout(params: {
  symbol: string;
  market: MarketType;
  lastPrice: number;
  cumVolUnits: number;
  suggestedPivot: number;
  suggestedStopLoss: number;
  volMa50Shares: number;
  simulatedTimeHHMM: string;
  volMultiplier?: number;
  accountEquity?: number;
  riskPct?: number;
  allowOddLot?: boolean;
}): BreakoutEvaluation {
  const {
    symbol,
    market,
    lastPrice,
    cumVolUnits,
    suggestedPivot,
    suggestedStopLoss,
    volMa50Shares,
    simulatedTimeHHMM,
    volMultiplier = 1.5,
    accountEquity = market === 'TW' ? 2_000_000 : 100_000,
    riskPct = 1.0,
    allowOddLot = false,
  } = params;

  const est = estimateFullDayVolume(market, cumVolUnits, simulatedTimeHHMM);
  const priceTriggered = suggestedPivot > 0 && lastPrice >= suggestedPivot;
  const estVolRatio =
    est.estimated_vol_shares !== null && volMa50Shares > 0
      ? round(est.estimated_vol_shares / volMa50Shares, 2)
      : null;
  const volumeTriggered = estVolRatio !== null && estVolRatio >= volMultiplier;

  const positionSizing =
    suggestedPivot > 0 && suggestedStopLoss > 0 && suggestedPivot > suggestedStopLoss
      ? calculatePositionSize({
          market,
          accountEquity,
          riskPct,
          entryPrice: lastPrice > 0 ? lastPrice : suggestedPivot,
          stopLossPrice: suggestedStopLoss,
          allowOddLot,
        })
      : null;

  return {
    symbol,
    market,
    last_price: round(lastPrice, 2),
    suggested_pivot: round(suggestedPivot, 2),
    price_triggered: priceTriggered,
    vol_ma50_shares: Math.round(volMa50Shares),
    est_vol_ratio_50d: estVolRatio,
    volume_triggered: volumeTriggered,
    triggered: priceTriggered && volumeTriggered,
    volume_estimate: est,
    position_sizing: positionSizing,
  };
}

export function parseCsvOhlcv(csvText: string): OhlcvBar[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error('CSV 至少需要標頭列與一筆資料列');
  }

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idxDate = headers.findIndex((h) => ['date', 'time', 'datetime', 't'].includes(h));
  const idxOpen = headers.findIndex((h) => ['open', 'o'].includes(h));
  const idxHigh = headers.findIndex((h) => ['high', 'h'].includes(h));
  const idxLow = headers.findIndex((h) => ['low', 'l'].includes(h));
  const idxClose = headers.findIndex((h) => ['close', 'c', 'adj close', 'adjclose'].includes(h));
  const idxVol = headers.findIndex((h) => ['volume', 'vol', 'v'].includes(h));

  if ([idxDate, idxOpen, idxHigh, idxLow, idxClose, idxVol].some((i) => i < 0)) {
    throw new Error('CSV 缺少必要欄位：需包含 date, open, high, low, close, volume');
  }

  const rows: OhlcvBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    if (cols.length <= Math.max(idxDate, idxOpen, idxHigh, idxLow, idxClose, idxVol)) continue;
    let dateStr = cols[idxDate];
    if (/^\d{10}$/.test(dateStr)) {
      dateStr = new Date(Number(dateStr) * 1000).toISOString().slice(0, 10);
    } else if (/^\d{13}$/.test(dateStr)) {
      dateStr = new Date(Number(dateStr)).toISOString().slice(0, 10);
    }
    rows.push({
      date: dateStr.slice(0, 10),
      open: Number(cols[idxOpen]),
      high: Number(cols[idxHigh]),
      low: Number(cols[idxLow]),
      close: Number(cols[idxClose]),
      volume: Number(cols[idxVol]),
    });
  }
  return normalizeOhlcv(rows);
}
