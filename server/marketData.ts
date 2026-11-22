import type { MarketType, OhlcvBar, ScreenerCandidate } from './types.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const historyCache = new Map<string, CacheEntry<OhlcvBar[]>>();
const screenerCache = new Map<string, CacheEntry<ScreenerCandidate[]>>();
let twChipsCache: CacheEntry<Record<string, Record<string, any>>> | null = null;

function getCache<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = map.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value;
  }
  return null;
}

async function fetchJsonWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        ...(options.headers || {}),
      },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} from ${url}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function formatDateInTz(unixSeconds: number, timeZone: string): string {
  const d = new Date(unixSeconds * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${day}`;
}

export async function fetchYahooV8Adjusted(
  ticker: string,
  market: MarketType,
  bars = 330
): Promise<OhlcvBar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`;
  const payload = await fetchJsonWithTimeout(url, {}, 15000);
  const result = payload?.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo Finance v8 無資料: ${ticker}`);
  }

  const ts: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjList: (number | null)[] | undefined = result.indicators?.adjclose?.[0]?.adjclose;
  const metaPrice = result.meta?.regularMarketPrice;

  if (ts.length === 0) {
    throw new Error(`Yahoo Finance v8 K 棒為空: ${ticker}`);
  }

  const opens: (number | null)[] = [...(quote.open || [])];
  const highs: (number | null)[] = [...(quote.high || [])];
  const lows: (number | null)[] = [...(quote.low || [])];
  const closes: (number | null)[] = [...(quote.close || [])];
  const vols: (number | null)[] = [...(quote.volume || [])];
  const adjs: (number | null)[] = adjList && adjList.length === ts.length ? [...adjList] : new Array(ts.length).fill(null);

  const last = ts.length - 1;
  if (closes[last] == null && opens[last] != null && metaPrice != null && Number(metaPrice) > 0) {
    const mp = Number(metaPrice);
    closes[last] = mp;
    adjs[last] = mp;
    if (highs[last] == null) highs[last] = Math.max(Number(opens[last]), mp);
    if (lows[last] == null) lows[last] = Math.min(Number(opens[last]), mp);
  }

  const tz = market === 'TW' ? 'Asia/Taipei' : 'America/New_York';
  const byDate = new Map<string, OhlcvBar>();

  for (let i = 0; i < ts.length; i++) {
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (o == null || h == null || l == null || c == null || c <= 0) continue;

    const adj = adjs[i];
    const factor = adj != null && adj > 0 ? adj / c : 1.0;
    const validFactor = Number.isFinite(factor) && factor > 0 ? factor : 1.0;
    const date = formatDateInTz(ts[i], tz);

    byDate.set(date, {
      date,
      open: o * validFactor,
      high: h * validFactor,
      low: l * validFactor,
      close: adj != null && adj > 0 ? adj : c,
      volume: Math.max(0, Number(vols[i] ?? 0)),
    });
  }

  const sorted = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  return sorted.slice(-bars);
}

function twTickerCandidates(symbol: string, exchange?: string | null): string[] {
  const clean = symbol.trim().toUpperCase();
  if (clean.startsWith('^') || clean.includes('.')) return [clean];
  if ((exchange || '').toUpperCase() === 'TPEX') {
    return [`${clean}.TWO`, `${clean}.TW`];
  }
  return [`${clean}.TW`, `${clean}.TWO`];
}

export async function fetchAdjustedHistory(
  symbol: string,
  market: MarketType,
  bars = 330,
  exchange?: string | null
): Promise<OhlcvBar[]> {
  const key = `${market}:${symbol.toUpperCase()}`;
  const cached = getCache(historyCache, key);
  if (cached && cached.length >= (market === 'TW' ? 265 : 225)) {
    return cached.slice(-bars);
  }

  const minBars = market === 'TW' ? 265 : 225;
  const candidates = market === 'TW' ? twTickerCandidates(symbol, exchange) : [symbol.trim().toUpperCase()];

  let lastErr: unknown = null;
  for (const ticker of candidates) {
    try {
      const df = await fetchYahooV8Adjusted(ticker, market, bars);
      if (df.length >= minBars) {
        historyCache.set(key, { value: df, expiresAt: Date.now() + 6 * 3600 * 1000 });
        return df.slice(-bars);
      }
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(
    `無法取得 ${market}:${symbol} 還原權息歷史 K 線（${lastErr instanceof Error ? lastErr.message : '無資料'}）`
  );
}

function pass52wFilter(item: ScreenerCandidate): boolean {
  const c = item.close;
  const h52 = item.price_52w_high;
  const l52 = item.price_52w_low;
  if (!c || !h52 || !l52 || c <= 0 || h52 <= 0 || l52 <= 0) return false;
  return c >= h52 * 0.75 && c >= l52 * 1.3;
}

function parseTvRows(rows: any[], cols: string[], isUs: boolean): ScreenerCandidate[] {
  const parsed: ScreenerCandidate[] = [];
  for (const row of rows) {
    const vals: any[] = row?.d || [];
    const m: Record<string, any> = {};
    cols.forEach((col, i) => {
      m[col] = vals[i];
    });
    const sym = String(m.name || '').trim();
    if (!sym) continue;

    let nextEarningsDate: string | null = null;
    if (isUs && m.earnings_release_next_date != null) {
      const ts = Number(m.earnings_release_next_date);
      if (Number.isFinite(ts) && ts > 0) {
        nextEarningsDate = formatDateInTz(ts, 'America/New_York');
      }
    }

    parsed.push({
      symbol: sym,
      tv_symbol: String(row.s || sym),
      name: String(m.description || sym),
      exchange: String(m.exchange || ''),
      sector: m.sector ?? null,
      close: m.close != null ? Number(m.close) : null,
      price_52w_high: m.price_52_week_high != null ? Number(m.price_52_week_high) : null,
      price_52w_low: m.price_52_week_low != null ? Number(m.price_52_week_low) : null,
      avg_vol_30d: m.average_volume_30d_calc != null ? Number(m.average_volume_30d_calc) : null,
      value_traded: m['Value.Traded'] != null ? Number(m['Value.Traded']) : null,
      rel_vol_10d: m.relative_volume_10d_calc != null ? Number(m.relative_volume_10d_calc) : null,
      next_earnings_date: nextEarningsDate,
      eps_yoy_fq: isUs && m.earnings_per_share_diluted_yoy_growth_fq != null
        ? Number(m.earnings_per_share_diluted_yoy_growth_fq)
        : null,
      rev_yoy_fq: isUs && m.total_revenue_yoy_growth_fq != null
        ? Number(m.total_revenue_yoy_growth_fq)
        : null,
    });
  }
  return parsed;
}

async function postTvScan(scannerMarket: 'america' | 'taiwan', payload: Record<string, any>): Promise<any> {
  return fetchJsonWithTimeout(
    `https://scanner.tradingview.com/${scannerMarket}/scan`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    15000
  );
}

export async function runStage2Screener(market: MarketType, limit = 40): Promise<ScreenerCandidate[]> {
  const cacheKey = `${market}:${limit}`;
  const cached = getCache(screenerCache, cacheKey);
  if (cached) return cached;

  const isUs = market === 'US';
  let candidates: ScreenerCandidate[] = [];

  if (isUs) {
    const cols = [
      'name',
      'description',
      'exchange',
      'sector',
      'close',
      'SMA50',
      'SMA150',
      'SMA200',
      'price_52_week_high',
      'price_52_week_low',
      'average_volume_30d_calc',
      'Value.Traded',
      'relative_volume_10d_calc',
      'earnings_release_next_date',
      'earnings_per_share_diluted_yoy_growth_fq',
      'total_revenue_yoy_growth_fq',
    ];
    const payload = {
      markets: ['america'],
      symbols: { query: { types: ['stock'] } },
      filter: [
        { left: 'exchange', operation: 'in_range', right: ['NASDAQ', 'NYSE', 'AMEX'] },
        { left: 'close', operation: 'greater', right: 10 },
        { left: 'close', operation: 'greater', right: 'SMA50' },
        { left: 'SMA50', operation: 'greater', right: 'SMA150' },
        { left: 'SMA150', operation: 'greater', right: 'SMA200' },
        { left: 'average_volume_30d_calc', operation: 'greater', right: 300000 },
        { left: 'Value.Traded', operation: 'greater', right: 10000000 },
      ],
      columns: cols,
      sort: { sortBy: 'Value.Traded', sortOrder: 'desc' },
      range: [0, 250],
    };
    const resp = await postTvScan('america', payload);
    candidates = parseTvRows(resp?.data || [], cols, true).filter(pass52wFilter);
  } else {
    const cols = [
      'name',
      'description',
      'exchange',
      'sector',
      'close',
      'SMA50',
      'SMA100',
      'SMA200',
      'price_52_week_high',
      'price_52_week_low',
      'average_volume_30d_calc',
      'Value.Traded',
      'relative_volume_10d_calc',
    ];
    const basePayload = {
      markets: ['taiwan'],
      symbols: { query: { types: ['stock'] } },
      filter: [
        { left: 'close', operation: 'greater', right: 15 },
        { left: 'close', operation: 'greater', right: 'SMA50' },
        { left: 'SMA50', operation: 'greater', right: 'SMA100' },
        { left: 'SMA100', operation: 'greater', right: 'SMA200' },
        { left: 'average_volume_30d_calc', operation: 'greater', right: 200000 },
      ],
      columns: cols,
      sort: { sortBy: 'Value.Traded', sortOrder: 'desc' },
      range: [0, 250],
    };
    const resp = await postTvScan('taiwan', basePayload);
    candidates = parseTvRows(resp?.data || [], cols, false).filter(pass52wFilter);

    if (candidates.length < 30) {
      const suppPayload = {
        ...basePayload,
        filter: [
          { left: 'close', operation: 'greater', right: 15 },
          { left: 'close', operation: 'greater', right: 'SMA50' },
          { left: 'SMA50', operation: 'greater', right: 'SMA200' },
          { left: 'average_volume_30d_calc', operation: 'greater', right: 200000 },
        ],
      };
      const suppResp = await postTvScan('taiwan', suppPayload);
      const seen = new Set(candidates.map((c) => c.symbol));
      for (const item of parseTvRows(suppResp?.data || [], cols, false)) {
        if (!seen.has(item.symbol) && pass52wFilter(item)) {
          candidates.push(item);
          seen.add(item.symbol);
          if (candidates.length >= limit) break;
        }
      }
    }
  }

  const sliced = candidates.slice(0, limit);
  screenerCache.set(cacheKey, { value: sliced, expiresAt: Date.now() + 15 * 60 * 1000 });
  return sliced;
}

export async function fetchTvUsFundamentals(symbol: string): Promise<ScreenerCandidate | null> {
  const cols = [
    'name',
    'description',
    'exchange',
    'sector',
    'close',
    'price_52_week_high',
    'price_52_week_low',
    'average_volume_30d_calc',
    'Value.Traded',
    'relative_volume_10d_calc',
    'earnings_release_next_date',
    'earnings_per_share_diluted_yoy_growth_fq',
    'total_revenue_yoy_growth_fq',
  ];
  const payload = {
    markets: ['america'],
    symbols: { query: { types: ['stock'] } },
    filter: [
      { left: 'name', operation: 'equal', right: symbol.toUpperCase() },
      { left: 'exchange', operation: 'in_range', right: ['NASDAQ', 'NYSE', 'AMEX'] },
    ],
    columns: cols,
    range: [0, 5],
  };
  try {
    const resp = await postTvScan('america', payload);
    const rows = parseTvRows(resp?.data || [], cols, true);
    return rows.find((r) => r.symbol.toUpperCase() === symbol.toUpperCase()) || rows[0] || null;
  } catch {
    return null;
  }
}

function tradingDaysUntil(targetDateStr: string | null): number | null {
  if (!targetDateStr) return null;
  const target = new Date(`${targetDateStr.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const sign = target >= base ? 1 : -1;
  const start = sign > 0 ? base : target;
  const end = sign > 0 ? target : base;

  let count = 0;
  const cur = new Date(start.getTime());
  while (cur < end) {
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return sign * count;
}

export async function buildUsCatalysts(
  symbol: string,
  screenerRow?: ScreenerCandidate | null,
  earningsWarningDays = 7
): Promise<Record<string, any>> {
  const row = screenerRow ?? (await fetchTvUsFundamentals(symbol));
  const nextEarningsDate = row?.next_earnings_date ?? null;
  const daysToEarnings = tradingDaysUntil(nextEarningsDate);
  const earningsWarning = daysToEarnings !== null && daysToEarnings >= 0 && daysToEarnings <= earningsWarningDays;

  return {
    source: 'TradingView',
    sector: row?.sector ?? null,
    next_earnings_date: nextEarningsDate,
    trading_days_to_earnings: daysToEarnings,
    earnings_warning: earningsWarning,
    warning_flag: earningsWarning ? 'EARNINGS_WARNING' : null,
    eps_yoy_fq_pct: row?.eps_yoy_fq != null ? Math.round(row.eps_yoy_fq * 100) / 100 : null,
    revenue_yoy_fq_pct: row?.rev_yoy_fq != null ? Math.round(row.rev_yoy_fq * 100) / 100 : null,
  };
}

// --- TW Chips & Monthly Revenue (TWSE + TPEx) ---

function parseNum(val: any): number | null {
  const s = String(val ?? '').replace(/,/g, '').trim();
  if (!s || s === '-' || s === '--' || s === 'N/A' || s === 'NaN') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrZero(val: any): number {
  const n = parseNum(val);
  return n === null ? 0 : Math.round(n);
}

function parseRevenueRows(rows: any): Record<string, any> {
  if (!Array.isArray(rows)) return {};
  const out: Record<string, any> = {};
  for (const row of rows) {
    const code = String(row?.['公司代號'] || '').trim();
    if (!code) continue;
    const mom = parseNum(row['營業收入-上月比較增減(%)']);
    const yoy = parseNum(row['營業收入-去年同月增減(%)']);
    const cumYoy = parseNum(row['累計營業收入-前期比較增減(%)']);
    const revK = parseIntOrZero(row['營業收入-當月營收']);
    out[code] = {
      name_zh: String(row['公司名稱'] || '').trim() || null,
      industry: String(row['產業別'] || '').trim() || null,
      monthly_revenue: {
        year_month: String(row['資料年月'] || '').trim() || null,
        revenue_thousand_twd: revK,
        mom_pct: mom !== null ? Math.round(mom * 100) / 100 : null,
        yoy_pct: yoy !== null ? Math.round(yoy * 100) / 100 : null,
        cum_yoy_pct: cumYoy !== null ? Math.round(cumYoy * 100) / 100 : null,
      },
    };
  }
  return out;
}

function formatYmdTaipei(daysAgo: number): string {
  const ms = Date.now() - daysAgo * 86400 * 1000;
  return formatDateInTz(Math.floor(ms / 1000), 'Asia/Taipei').replace(/-/g, '');
}

async function fetchTwseT86Days(maxDays = 3): Promise<Array<[string, Record<string, any>]>> {
  const collected: Array<[string, Record<string, any>]> = [];
  for (let offset = 0; offset < 10 && collected.length < maxDays; offset++) {
    const ymd = formatYmdTaipei(offset);
    try {
      const resp = await fetchJsonWithTimeout(
        `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&selectType=ALLBUT0999&date=${ymd}`,
        {},
        10000
      );
      if (resp?.stat !== 'OK' || !Array.isArray(resp?.data) || resp.data.length === 0) continue;
      const dayMap: Record<string, any> = {};
      for (const row of resp.data) {
        if (!Array.isArray(row) || row.length < 19) continue;
        const code = String(row[0] || '').trim();
        if (!code) continue;
        const foreignShares = parseIntOrZero(row[4]) + parseIntOrZero(row[7]);
        const trustShares = parseIntOrZero(row[10]);
        const dealerShares = parseIntOrZero(row[11]);
        const totalShares = parseIntOrZero(row[18]);
        dayMap[code] = {
          name_zh: String(row[1] || '').trim() || null,
          foreign: Math.round(foreignShares / 1000),
          trust: Math.round(trustShares / 1000),
          dealer: Math.round(dealerShares / 1000),
          total: Math.round(totalShares / 1000),
        };
      }
      if (Object.keys(dayMap).length > 0) {
        collected.push([ymd, dayMap]);
      }
    } catch {
      continue;
    }
  }
  return collected;
}

async function fetchTwseMargin(ymd: string): Promise<Record<string, any>> {
  try {
    const resp = await fetchJsonWithTimeout(
      `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&selectType=ALL&date=${ymd}`,
      {},
      10000
    );
    if (resp?.stat !== 'OK') return {};
    let targetRows: any[] = [];
    for (const tbl of resp.tables || []) {
      const fields = tbl.fields || [];
      if (fields.length > 0 && String(fields[0]).trim() === '代號') {
        targetRows = tbl.data || [];
        break;
      }
    }
    const out: Record<string, any> = {};
    for (const row of targetRows) {
      if (!Array.isArray(row) || row.length < 13) continue;
      const code = String(row[0] || '').trim();
      if (!code) continue;
      const mPrev = parseIntOrZero(row[5]);
      const mToday = parseIntOrZero(row[6]);
      const sPrev = parseIntOrZero(row[11]);
      const sToday = parseIntOrZero(row[12]);
      out[code] = {
        margin_balance_lots: mToday,
        margin_change_lots: mToday - mPrev,
        short_balance_lots: sToday,
        short_change_lots: sToday - sPrev,
      };
    }
    return out;
  } catch {
    return {};
  }
}

async function fetchTpexInst(): Promise<{ date: string | null; inst: Record<string, any>; names: Record<string, string> }> {
  try {
    const rows = await fetchJsonWithTimeout('https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading', {}, 10000);
    if (!Array.isArray(rows)) return { date: null, inst: {}, names: {} };
    const inst: Record<string, any> = {};
    const names: Record<string, string> = {};
    let latestDate: string | null = null;
    for (const row of rows) {
      const code = String(row?.SecuritiesCompanyCode || '').trim();
      if (!code) continue;
      if (!latestDate && row?.Date) latestDate = String(row.Date).trim();
      const compName = String(row?.CompanyName || '').trim();
      if (compName) names[code] = compName;
      const findNoSpace = (target: string) => {
        for (const [k, v] of Object.entries(row)) {
          if (k.replace(/\s+/g, '') === target) return v;
        }
        return 0;
      };
      const fRaw =
        row['ForeignInvestorsInclude MainlandAreaInvestors-Difference'] ??
        findNoSpace('ForeignInvestorsIncludeMainlandAreaInvestors-Difference');
      const tRaw =
        row['SecuritiesInvestmentTrustCompanies-Difference'] ??
        findNoSpace('SecuritiesInvestmentTrustCompanies-Difference');
      const dRaw = row['Dealers-Difference'] ?? findNoSpace('Dealers-Difference');
      const totRaw = row['TotalDifference'] ?? findNoSpace('TotalDifference');
      inst[code] = {
        foreign: Math.round(parseIntOrZero(fRaw) / 1000),
        trust: Math.round(parseIntOrZero(tRaw) / 1000),
        dealer: Math.round(parseIntOrZero(dRaw) / 1000),
        total: Math.round(parseIntOrZero(totRaw) / 1000),
      };
    }
    return { date: latestDate, inst, names };
  } catch {
    return { date: null, inst: {}, names: {} };
  }
}

async function fetchTpexMargin(): Promise<Record<string, any>> {
  try {
    const rows = await fetchJsonWithTimeout('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance', {}, 10000);
    if (!Array.isArray(rows)) return {};
    const out: Record<string, any> = {};
    for (const row of rows) {
      const code = String(row?.SecuritiesCompanyCode || '').trim();
      if (!code) continue;
      const mPrev = parseIntOrZero(row.MarginPurchaseBalancePreviousDay);
      const mToday = parseIntOrZero(row.MarginPurchaseBalance);
      const sPrev = parseIntOrZero(row.ShortSaleBalancePreviousDay);
      const sToday = parseIntOrZero(row.ShortSaleBalance);
      const util = parseNum(row.MarginPurchaseUtilizationRate);
      out[code] = {
        margin_balance_lots: mToday,
        margin_change_lots: mToday - mPrev,
        short_balance_lots: sToday,
        short_change_lots: sToday - sPrev,
        margin_utilization_pct: util !== null ? Math.round(util * 100) / 100 : null,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadTwChipsSnapshot(): Promise<Record<string, Record<string, any>>> {
  if (twChipsCache && twChipsCache.expiresAt > Date.now()) {
    return twChipsCache.value;
  }

  const [twseDays, twseRevRaw, tpexInstRes, tpexMargin, tpexRevRaw] = await Promise.all([
    fetchTwseT86Days(5).catch(() => []),
    fetchJsonWithTimeout('https://openapi.twse.com.tw/v1/opendata/t187ap05_L', {}, 10000).catch(() => []),
    fetchTpexInst(),
    fetchTpexMargin(),
    fetchJsonWithTimeout('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O', {}, 10000).catch(() => []),
  ]);

  const latestTwseDate = twseDays.length > 0 ? twseDays[0][0] : null;
  const twseMargin = latestTwseDate ? await fetchTwseMargin(latestTwseDate) : {};
  const twseRev = parseRevenueRows(twseRevRaw);
  const tpexRev = parseRevenueRows(tpexRevRaw);

  const snapshot: Record<string, Record<string, any>> = {};
  const twseLatestInst = twseDays.length > 0 ? twseDays[0][1] : {};
  const twseCodes = new Set([...Object.keys(twseLatestInst), ...Object.keys(twseMargin), ...Object.keys(twseRev)]);

  for (const code of twseCodes) {
    const raw1d = twseLatestInst[code];
    const inst1d = raw1d
      ? { foreign: raw1d.foreign, trust: raw1d.trust, dealer: raw1d.dealer, total: raw1d.total }
      : null;

    let inst5d: Record<string, number> | null = null;
    let streak = 0;
    if (twseDays.length > 0) {
      const agg = { foreign: 0, trust: 0, dealer: 0, total: 0 };
      let hasAny = false;
      let streakBroken = false;
      for (const [, dmap] of twseDays) {
        const row = dmap[code];
        if (row) {
          hasAny = true;
          agg.foreign += row.foreign;
          agg.trust += row.trust;
          agg.dealer += row.dealer;
          agg.total += row.total;
          if (!streakBroken && row.trust > 0) streak += 1;
          else streakBroken = true;
        } else {
          streakBroken = true;
        }
      }
      if (hasAny) inst5d = agg;
    }

    const revInfo = twseRev[code] || {};
    snapshot[code] = {
      source: 'TWSE',
      market_board: 'TWSE',
      name_zh: revInfo.name_zh || raw1d?.name_zh || null,
      data_date: latestTwseDate,
      industry: revInfo.industry || null,
      monthly_revenue: revInfo.monthly_revenue || null,
      institutional_1d_lots: inst1d,
      institutional_5d_lots: inst5d,
      trust_buy_streak_days: streak,
      margin: twseMargin[code] || null,
    };
  }

  const tpexCodes = new Set([
    ...Object.keys(tpexInstRes.inst),
    ...Object.keys(tpexMargin),
    ...Object.keys(tpexRev),
  ]);
  for (const code of tpexCodes) {
    if (snapshot[code]) continue;
    const revInfo = tpexRev[code] || {};
    const inst1d = tpexInstRes.inst[code] || null;
    snapshot[code] = {
      source: 'TPEX',
      market_board: 'TPEX',
      name_zh: revInfo.name_zh || tpexInstRes.names[code] || null,
      data_date: tpexInstRes.date,
      industry: revInfo.industry || null,
      monthly_revenue: revInfo.monthly_revenue || null,
      institutional_1d_lots: inst1d,
      institutional_5d_lots: null,
      trust_buy_streak_days: inst1d && inst1d.trust > 0 ? 1 : 0,
      margin: tpexMargin[code] || null,
    };
  }

  if (Object.keys(snapshot).length > 0) {
    twChipsCache = { value: snapshot, expiresAt: Date.now() + 6 * 3600 * 1000 };
  }
  return snapshot;
}

export function isTwListedOrOtc(symbol: string, snapshot: Record<string, Record<string, any>>): boolean {
  if (!snapshot || Object.keys(snapshot).length === 0) return true;
  const code = symbol.split('.')[0].trim();
  const entry = snapshot[code];
  return Boolean(entry && (entry.market_board === 'TWSE' || entry.market_board === 'TPEX'));
}

export async function fetchTwCatalysts(
  symbol: string,
  snapshot?: Record<string, Record<string, any>> | null
): Promise<Record<string, any>> {
  const code = symbol.split('.')[0].trim();
  const data = snapshot ?? (await loadTwChipsSnapshot());
  const entry = data[code];
  if (!entry) {
    return { status: 'NOT_FOUND_IN_TWSE_TPEX', symbol: code };
  }
  return { ...entry };
}
