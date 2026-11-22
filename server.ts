import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import yaml from 'js-yaml';
import {
  buildUsCatalysts,
  fetchAdjustedHistory,
  fetchTwCatalysts,
  isTwListedOrOtc,
  loadTwChipsSnapshot,
  runStage2Screener,
} from './server/marketData.ts';
import {
  formatIntradayBreakoutAlert,
  formatPostMarketSummary,
  getTelegramStatus,
  sendTelegramMessage,
} from './server/telegram.ts';
import type { FocusListItem, MarketType, PostMarketScanReport } from './server/types.ts';
import {
  assignRsRatings,
  calculateVcpMetrics,
  classifyVcpTier,
  EARNINGS_DOWNGRADE,
  evaluateBreakout,
  GRADE_PRIORITY,
  MARKET_CONFIGS,
  parseCsvOhlcv,
  scoreCandidate,
  STATUS_PRIORITY,
  TIER_PRIORITY,
} from './server/vcpEngine.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const HOST = '0.0.0.0';

// In-memory store for latest scan reports per market
const savedWatchlists = new Map<MarketType, PostMarketScanReport>();

function parseMarket(raw: unknown): MarketType {
  const m = String(raw || 'US').toUpperCase();
  return m === 'TW' ? 'TW' : 'US';
}

function loadMarketsYaml(): Record<string, any> {
  try {
    const yamlPath = path.join(__dirname, 'config', 'markets.yaml');
    if (fs.existsSync(yamlPath)) {
      return (yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as Record<string, any>) || {};
    }
  } catch {
    // Fallback to hardcoded defaults below
  }
  return { markets: MARKET_CONFIGS };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        const value = await worker(items[idx]);
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

async function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  // Config & Integration Status (never exposes secret values)
  app.get('/api/config', (_req, res) => {
    const marketsYaml = loadMarketsYaml();
    res.json({
      markets: marketsYaml.markets || MARKET_CONFIGS,
      integrations: {
        telegram: getTelegramStatus(),
        shioaji: {
          has_api_key: Boolean(process.env.SJ_API_KEY || process.env.SHIOAJI_API_KEY),
          has_secret_key: Boolean(process.env.SJ_SEC_KEY || process.env.SHIOAJI_SECRET_KEY),
          production: String(process.env.SJ_PRODUCTION || '').toLowerCase() === 'true',
          note: 'Node.js 雲端環境使用即時模擬與 Yahoo/TWSE 還原資料；本機永豐 Python SDK 不適用雲端容器',
        },
        tradingview_scanner: { enabled: true, protocol: 'HTTPS' },
        yahoo_adjusted_ohlcv: { enabled: true, protocol: 'HTTPS' },
        twse_tpex_chips: { enabled: true, protocol: 'HTTPS' },
      },
      saved_watchlists: {
        US: savedWatchlists.get('US')
          ? {
              generated_at: savedWatchlists.get('US')!.generated_at,
              focus_count: savedWatchlists.get('US')!.focus_list.length,
              benchmark_trend: savedWatchlists.get('US')!.benchmark_trend,
            }
          : null,
        TW: savedWatchlists.get('TW')
          ? {
              generated_at: savedWatchlists.get('TW')!.generated_at,
              focus_count: savedWatchlists.get('TW')!.focus_list.length,
              benchmark_trend: savedWatchlists.get('TW')!.benchmark_trend,
            }
          : null,
      },
    });
  });

  // Workflow A: Single-Stock 4-Gate Deep Diagnosis (live Yahoo v8 + Catalysts)
  app.get('/api/single-stock', async (req, res) => {
    const t0 = Date.now();
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    const market = parseMarket(req.query.market);
    const includeCatalysts = req.query.catalysts !== 'false';

    if (!symbol || !/^[A-Z0-9^._-]{1,16}$/.test(symbol)) {
      res.status(400).json({ error: '請輸入有效的股票代號（例如 NVDA 或 2330）' });
      return;
    }

    const cfg = MARKET_CONFIGS[market];
    try {
      const [stockBars, benchBars] = await Promise.all([
        fetchAdjustedHistory(symbol, market, 330),
        fetchAdjustedHistory(cfg.benchmarkSymbol, market, 330),
      ]);

      let catalysts: Record<string, any> | null = null;
      if (includeCatalysts) {
        try {
          catalysts =
            market === 'TW'
              ? await fetchTwCatalysts(symbol)
              : await buildUsCatalysts(symbol, null, cfg.earningsWarningDays);
        } catch {
          catalysts = { status: 'CATALYST_FETCH_FAILED' };
        }
      }

      const { metrics, chart, volMa50 } = calculateVcpMetrics(symbol, stockBars, benchBars, market, catalysts);
      const vcpScore = scoreCandidate(metrics, market);

      res.json({
        result: metrics,
        vcp_score: vcpScore,
        vol_ma50: volMa50,
        chart,
        data_source: 'Yahoo Finance v8 (Adjusted OHLCV)',
        elapsed_ms: Date.now() - t0,
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : '單股分析執行失敗',
      });
    }
  });

  // Workflow A (CSV mode): Custom OHLCV CSV diagnostic (mirrors calc_vcp_metrics.py --stock-csv)
  app.post('/api/single-stock/csv', async (req, res) => {
    const t0 = Date.now();
    const symbol = String(req.body?.symbol || 'CUSTOM').trim().toUpperCase();
    const market = parseMarket(req.body?.market);
    const stockCsv = String(req.body?.stockCsv || '');
    const benchmarkCsv = String(req.body?.benchmarkCsv || '');

    if (!stockCsv.trim()) {
      res.status(400).json({ error: '請提供個股還原日線 OHLCV CSV 內容' });
      return;
    }

    const cfg = MARKET_CONFIGS[market];
    try {
      const stockBars = parseCsvOhlcv(stockCsv);
      const benchBars = benchmarkCsv.trim()
        ? parseCsvOhlcv(benchmarkCsv)
        : await fetchAdjustedHistory(cfg.benchmarkSymbol, market, 330);

      const { metrics, chart, volMa50 } = calculateVcpMetrics(symbol, stockBars, benchBars, market, null);
      const vcpScore = scoreCandidate(metrics, market);

      res.json({
        result: metrics,
        vcp_score: vcpScore,
        vol_ma50: volMa50,
        chart,
        data_source: 'Custom CSV Upload',
        elapsed_ms: Date.now() - t0,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'CSV 解析或指標計算失敗',
      });
    }
  });

  // Workflow B: Post-Market Full-Market Funnel Scan (run_post_market_scan.py)
  app.get('/api/watchlist/:market', (req, res) => {
    const market = parseMarket(req.params.market);
    const saved = savedWatchlists.get(market);
    if (!saved) {
      res.json({ report: null });
      return;
    }
    res.json({ report: saved });
  });

  app.post('/api/scan', async (req, res) => {
    const market = parseMarket(req.body?.market);
    const maxCandidates = Math.min(150, Math.max(10, Number(req.body?.maxCandidates || 150)));
    const focusMin = Math.min(15, Math.max(0, Number(req.body?.focusMin ?? 0)));
    const focusMax = Math.min(20, Math.max(focusMin, Number(req.body?.focusMax || 15)));

    const cfg = MARKET_CONFIGS[market];

    try {
      let candidates = await runStage2Screener(market, maxCandidates);
      const rawScreenedCount = candidates.length;

      let excludedOes: string[] = [];
      let twSnapshot: Record<string, Record<string, any>> | null = null;
      const benchPromise = fetchAdjustedHistory(cfg.benchmarkSymbol, market, 330);

      if (market === 'TW') {
        twSnapshot = await loadTwChipsSnapshot();
        excludedOes = candidates
          .filter((r) => !isTwListedOrOtc(r.symbol, twSnapshot!))
          .map((r) => r.symbol);
        if (excludedOes.length > 0) {
          candidates = candidates.filter((r) => isTwListedOrOtc(r.symbol, twSnapshot!));
        }
      }

      const benchBars = await benchPromise;

      const settled = await runWithConcurrency(candidates, 5, async (row) => {
        const stockBars = await fetchAdjustedHistory(row.symbol, market, 330, row.exchange);
        const catalysts =
          market === 'TW'
            ? await fetchTwCatalysts(row.symbol, twSnapshot)
            : await buildUsCatalysts(row.symbol, row, cfg.earningsWarningDays);

        const { metrics, volMa50 } = calculateVcpMetrics(row.symbol, stockBars, benchBars, market, catalysts);
        return { row, result: metrics, volMa50 };
      });

      const evaluated: Array<{ row: any; result: any; volMa50: number }> = [];
      let failedCount = 0;
      for (const s of settled) {
        if (s.status === 'fulfilled') evaluated.push(s.value);
        else failedCount += 1;
      }

      let stage2Count = 0;
      let vcpTightCount = 0;
      let earningsWarningCount = 0;

      assignRsRatings(evaluated);

      const scoredItems: Omit<FocusListItem, 'rank'>[] = evaluated.map(({ row, result, volMa50 }) => {
        const g1 = result.gate1_market;
        const g2 = result.gate2_trend_rs;
        const g3 = result.gate3_catalysts || {};
        const g4 = result.gate4_setup_risk;
        const meta = result.meta;

        if (g2.stage2_template_pass) stage2Count += 1;
        if (
          (g4.bbw_120d_percentile <= 25.0 && g4.atr_5_20_ratio <= 0.75 && g4.tightness_10d_pct <= 10.0) ||
          (g4.range_contracting && g4.range_5d_tight)
        ) {
          vcpTightCount += 1;
        }

        let score = scoreCandidate(result, market);
        const preGrade = meta.pre_filter_grade;
        let focusGrade: string = preGrade;
        const warnings: string[] = [];
        const hasEarningsWarn = Boolean(g3.earnings_warning);

        if (hasEarningsWarn) {
          earningsWarningCount += 1;
          warnings.push('EARNINGS_WARNING');
          focusGrade = EARNINGS_DOWNGRADE[preGrade] || preGrade;
          score = Math.max(0, score - 15);
        }
        if (g1.benchmark_trend === 'DOWNTREND') {
          warnings.push('MARKET_DOWNTREND');
        }

        const vcpTier = classifyVcpTier(result, market, evaluated.length, hasEarningsWarn);
        const setupStatus = String(g4.setup_status || meta.setup_status || 'CONSOLIDATING');

        return {
          symbol: row.symbol,
          name: row.name || row.symbol,
          name_zh: market === 'TW' ? String(g3.name_zh || '') : '',
          exchange: row.exchange || '',
          sector: row.sector ?? null,
          vcp_tier: vcpTier,
          setup_status: setupStatus,
          rs_rating: g2.rs_rating ?? null,
          focus_grade: focusGrade,
          pre_filter_grade: preGrade,
          vcp_score: score,
          warnings,
          close_price: meta.close_price,
          suggested_pivot: g4.suggested_pivot,
          suggested_stop_loss: g4.suggested_stop_loss,
          tight_stop_5d_low: g4.tight_stop_5d_low,
          stop_loss_pct: g4.stop_loss_pct,
          dist_to_pivot_pct: g4.dist_to_pivot_pct,
          target_2r: g4.target_2r,
          target_3r: g4.target_3r,
          vol_ma50: volMa50,
          metrics: result,
        };
      });

      const sortDesc = (a: Omit<FocusListItem, 'rank'>, b: Omit<FocusListItem, 'rank'>) => {
        const ta = TIER_PRIORITY[a.vcp_tier || 'B'] ?? 0;
        const tb = TIER_PRIORITY[b.vcp_tier || 'B'] ?? 0;
        if (tb !== ta) return tb - ta;
        const sa = STATUS_PRIORITY[a.setup_status || ''] ?? 0;
        const sb = STATUS_PRIORITY[b.setup_status || ''] ?? 0;
        if (sb !== sa) return sb - sa;
        const ga = GRADE_PRIORITY[a.focus_grade] ?? 0;
        const gb = GRADE_PRIORITY[b.focus_grade] ?? 0;
        if (gb !== ga) return gb - ga;
        if (b.vcp_score !== a.vcp_score) return b.vcp_score - a.vcp_score;
        return a.symbol.localeCompare(b.symbol);
      };

      const stage2Items = scoredItems
        .filter((x) => x.metrics.gate2_trend_rs.stage2_template_pass)
        .sort(sortDesc);
      const otherItems = scoredItems
        .filter((x) => !x.metrics.gate2_trend_rs.stage2_template_pass)
        .sort(sortDesc);

      const selected =
        stage2Items.length >= focusMin
          ? stage2Items.slice(0, focusMax)
          : [...stage2Items, ...otherItems.slice(0, Math.max(0, focusMin - stage2Items.length))].slice(0, focusMax);

      const focusList: FocusListItem[] = selected.map((item, idx) => ({
        rank: idx + 1,
        ...item,
      }));

      const bmTrend =
        focusList[0]?.metrics.gate1_market.benchmark_trend ||
        evaluated[0]?.result.gate1_market.benchmark_trend ||
        'UNKNOWN';

      const report: PostMarketScanReport = {
        generated_at: new Date().toISOString(),
        market,
        benchmark_symbol: cfg.benchmarkSymbol,
        benchmark_trend: bmTrend,
        market_regime_warning: bmTrend === 'DOWNTREND' ? 'BENCHMARK_DOWNTREND' : null,
        funnel_stats: {
          screened_count: rawScreenedCount,
          excluded_oes_count: excludedOes.length,
          calculated_count: evaluated.length,
          failed_count: failedCount,
          stage2_count: stage2Count,
          vcp_tight_count: vcpTightCount,
          earnings_warning_count: earningsWarningCount,
          focus_count: focusList.length,
        },
        focus_list: focusList,
      };

      savedWatchlists.set(market, report);
      res.json({ report });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : '盤後全市場漏斗海選失敗',
      });
    }
  });

  // Workflow C: Intraday Breakout Evaluator & 1% Risk Sizer (shioaji_client.py + risk_manager)
  app.post('/api/radar/evaluate', (req, res) => {
    try {
      const market = parseMarket(req.body?.market);
      const symbol = String(req.body?.symbol || '').trim().toUpperCase();
      const lastPrice = Number(req.body?.lastPrice);
      const cumVolUnits = Number(req.body?.cumVolUnits);
      const suggestedPivot = Number(req.body?.suggestedPivot);
      const suggestedStopLoss = Number(req.body?.suggestedStopLoss);
      const volMa50Shares = Number(req.body?.volMa50Shares);
      const simulatedTimeHHMM = String(req.body?.simulatedTimeHHMM || '10:30');
      const volMultiplier = Number(req.body?.volMultiplier || 1.5);
      const accountEquity = Number(req.body?.accountEquity || (market === 'TW' ? 2_000_000 : 100_000));
      const riskPct = Number(req.body?.riskPct || 1.0);
      const allowOddLot = Boolean(req.body?.allowOddLot);
      const nameZh = String(req.body?.nameZh || '');

      if (!symbol || !Number.isFinite(lastPrice) || !Number.isFinite(suggestedPivot)) {
        res.status(400).json({ error: '請提供有效的代號、即時價與 Pivot 價位' });
        return;
      }

      const evaluation = evaluateBreakout({
        symbol,
        market,
        lastPrice,
        cumVolUnits: Number.isFinite(cumVolUnits) ? cumVolUnits : 0,
        suggestedPivot,
        suggestedStopLoss: Number.isFinite(suggestedStopLoss) ? suggestedStopLoss : suggestedPivot * 0.94,
        volMa50Shares: Number.isFinite(volMa50Shares) ? volMa50Shares : 0,
        simulatedTimeHHMM,
        volMultiplier: Number.isFinite(volMultiplier) ? volMultiplier : 1.5,
        accountEquity,
        riskPct,
        allowOddLot,
      });

      const telegramPreview = formatIntradayBreakoutAlert({
        symbol,
        market,
        exchange: String(req.body?.exchange || ''),
        name_zh: nameZh,
        last_price: evaluation.last_price,
        suggested_pivot: evaluation.suggested_pivot,
        est_vol_ratio_50d: evaluation.est_vol_ratio_50d,
        suggested_stop_loss: evaluation.position_sizing?.stop_loss_price,
        stop_loss_pct: evaluation.position_sizing?.stop_loss_pct,
        suggested_shares: evaluation.position_sizing?.suggested_shares,
        risk_amount: evaluation.position_sizing?.actual_risk_amount,
      });

      res.json({ evaluation, telegram_preview: telegramPreview });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : '盤中突破試算失敗' });
    }
  });

  // Telegram Preview & Push
  app.post('/api/telegram/preview-scan', (req, res) => {
    const market = parseMarket(req.body?.market);
    const report = (req.body?.report as PostMarketScanReport | undefined) || savedWatchlists.get(market);
    if (!report) {
      res.status(404).json({ error: `尚未有 ${market} 的盤後海選結果` });
      return;
    }
    res.json({ html: formatPostMarketSummary(report) });
  });

  app.post('/api/telegram/send', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      res.status(400).json({ error: '推播訊息內容不可為空' });
      return;
    }
    try {
      const result = await sendTelegramMessage(text);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Telegram 推播失敗' });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, HOST, () => {
    console.log(`[vcp-trading] Server listening on http://${HOST}:${PORT}`);
  });
}

createApp().catch((err) => {
  console.error('[vcp-trading] Failed to start server:', err);
  process.exit(1);
});
