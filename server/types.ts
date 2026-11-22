export type MarketType = 'US' | 'TW';

export interface OhlcvBar {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketConfig {
  market: MarketType;
  maShort: number;
  maMid: number;
  maLong: number;
  benchmarkSymbol: string;
  maModeLabel: string;
  earningsWarningDays: number;
  intradayDelayMinutes: number;
  maxStopLossPct: number;
  accountRiskPerTradePct: number;
}

export interface ChartSeriesPoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma10: number | null;
  ma20: number | null;
  maShort: number | null;
  maMid: number | null;
  maLong: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  bbw: number | null;
  volMa50: number | null;
  rsLine: number | null;
  rsMa50: number | null;
}

export interface VcpMetricsResult {
  error?: string;
  symbol?: string;
  market?: MarketType;
  meta: {
    symbol: string;
    market: MarketType;
    data_date: string;
    close_price: number;
    benchmark_symbol: string;
    ma_mode: string;
    pre_filter_grade: 'A_CANDIDATE' | 'B_WATCHLIST' | 'B_OR_C_REVIEW' | 'C';
    setup_status?: 'BREAKOUT' | 'PIVOT_READY' | 'CONSOLIDATING' | 'EXTENDED' | 'NONE';
  };
  gate1_market: {
    benchmark_above_50ma: boolean;
    benchmark_above_200ma: boolean;
    benchmark_trend: 'UPTREND' | 'MIXED' | 'DOWNTREND';
  };
  gate2_trend_rs: {
    stage2_template_pass: boolean;
    ma_values: Record<string, number>;
    ma_long_rising_1m: boolean;
    pct_from_52w_high: number;
    pct_from_52w_low: number;
    rs_line_52w_high: boolean;
    rs_above_ma50: boolean;
    rs_raw_score?: number;
    rs_rating?: number | null;
  };
  gate3_catalysts: Record<string, any>;
  gate4_setup_risk: {
    bbw_current_pct: number;
    bbw_120d_percentile: number;
    price_above_bb_mid: boolean;
    adr_20d_pct: number;
    atr_5_20_ratio: number;
    atr14_pct_current?: number;
    atr14_pct_60d_percentile?: number;
    atr14_low_60d?: boolean;
    tightness_10d_pct: number;
    range_40d_pct?: number;
    range_20d_pct?: number;
    range_10d_pct?: number;
    range_5d_pct?: number;
    range_contracting?: boolean;
    contraction_steps?: number;
    range_5d_tight?: boolean;
    vol_ratio_50d: number;
    vol_ma5_to_50_ratio?: number;
    closing_range?: number;
    is_vdu_3d: boolean;
    is_vdu_5d?: boolean;
    pocket_pivot_in_5d: boolean;
    distribution_days_10d: number;
    dist_from_10ma_in_atr: number;
    prior_10d_high?: number;
    prior_10d_low?: number;
    prior_5d_low?: number;
    recent_10d_high: number;
    recent_10d_low: number;
    suggested_pivot: number;
    suggested_stop_loss: number;
    tight_stop_5d_low?: number;
    stop_loss_pct: number;
    stop_loss_in_atr: number;
    dist_to_pivot_pct?: number;
    setup_status?: string;
    target_2r?: number;
    target_3r?: number;
  };
}

export interface SingleStockResponse {
  result: VcpMetricsResult;
  vcp_score: number;
  vol_ma50: number;
  chart: ChartSeriesPoint[];
  data_source: string;
  elapsed_ms: number;
}

export interface ScreenerCandidate {
  symbol: string;
  tv_symbol: string;
  name: string;
  exchange: string;
  sector: string | null;
  close: number | null;
  price_52w_high: number | null;
  price_52w_low: number | null;
  avg_vol_30d: number | null;
  value_traded: number | null;
  perf_3m?: number | null;
  rel_vol_10d: number | null;
  next_earnings_date: string | null;
  eps_yoy_fq: number | null;
  rev_yoy_fq: number | null;
}

export interface FocusListItem {
  rank: number;
  symbol: string;
  name: string;
  name_zh: string;
  exchange: string;
  sector: string | null;
  vcp_tier?: 'S' | 'A' | 'B' | 'C';
  setup_status?: string;
  rs_rating?: number | null;
  focus_grade: string;
  pre_filter_grade: string;
  vcp_score: number;
  warnings: string[];
  close_price: number;
  suggested_pivot: number;
  suggested_stop_loss: number;
  tight_stop_5d_low?: number;
  stop_loss_pct: number;
  dist_to_pivot_pct?: number;
  target_2r?: number;
  target_3r?: number;
  vol_ma50: number;
  metrics: VcpMetricsResult;
}

export interface PostMarketScanReport {
  generated_at: string;
  market: MarketType;
  benchmark_symbol: string;
  benchmark_trend: string;
  market_regime_warning: string | null;
  funnel_stats: {
    screened_count: number;
    excluded_oes_count: number;
    calculated_count: number;
    failed_count: number;
    stage2_count: number;
    vcp_tight_count: number;
    earnings_warning_count: number;
    focus_count: number;
  };
  focus_list: FocusListItem[];
}

export interface VolumeEstimate {
  status: 'PRE_MARKET' | 'DELAY_WINDOW' | 'INTRADAY' | 'POST_MARKET';
  as_of: string;
  elapsed_minutes: number;
  cum_vol_units: number;
  cum_vol_shares: number;
  scale_factor: number | null;
  estimated_vol_units: number | null;
  estimated_vol_shares: number | null;
}

export interface BreakoutEvaluation {
  symbol: string;
  market: MarketType;
  last_price: number;
  suggested_pivot: number;
  price_triggered: boolean;
  vol_ma50_shares: number;
  est_vol_ratio_50d: number | null;
  volume_triggered: boolean;
  triggered: boolean;
  volume_estimate: VolumeEstimate;
  position_sizing: PositionSizingResult | null;
}

export interface PositionSizingResult {
  account_equity: number;
  risk_pct: number;
  max_risk_amount: number;
  entry_price: number;
  stop_loss_price: number;
  risk_per_share: number;
  stop_loss_pct: number;
  exceeds_max_stop_cap: boolean;
  raw_shares: number;
  suggested_shares: number;
  suggested_lots: number | null;
  position_value: number;
  position_weight_pct: number;
  actual_risk_amount: number;
}
