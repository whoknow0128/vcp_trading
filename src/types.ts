export type MarketType = 'US' | 'TW';

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
  meta: {
    symbol: string;
    market: MarketType;
    data_date: string;
    close_price: number;
    benchmark_symbol: string;
    ma_mode: string;
    pre_filter_grade: 'A_CANDIDATE' | 'B_WATCHLIST' | 'B_OR_C_REVIEW' | 'C';
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
  };
  gate3_catalysts: Record<string, any>;
  gate4_setup_risk: {
    bbw_current_pct: number;
    bbw_120d_percentile: number;
    price_above_bb_mid: boolean;
    adr_20d_pct: number;
    atr_5_20_ratio: number;
    tightness_10d_pct: number;
    vol_ratio_50d: number;
    is_vdu_3d: boolean;
    pocket_pivot_in_5d: boolean;
    distribution_days_10d: number;
    dist_from_10ma_in_atr: number;
    recent_10d_high: number;
    recent_10d_low: number;
    suggested_pivot: number;
    suggested_stop_loss: number;
    stop_loss_pct: number;
    stop_loss_in_atr: number;
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

export interface FocusListItem {
  rank: number;
  symbol: string;
  name: string;
  name_zh: string;
  exchange: string;
  sector: string | null;
  focus_grade: string;
  pre_filter_grade: string;
  vcp_score: number;
  warnings: string[];
  close_price: number;
  suggested_pivot: number;
  suggested_stop_loss: number;
  stop_loss_pct: number;
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
  volume_estimate: {
    status: 'PRE_MARKET' | 'DELAY_WINDOW' | 'INTRADAY' | 'POST_MARKET';
    as_of: string;
    elapsed_minutes: number;
    cum_vol_units: number;
    cum_vol_shares: number;
    scale_factor: number | null;
    estimated_vol_units: number | null;
    estimated_vol_shares: number | null;
  };
  position_sizing: {
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
  } | null;
}

export interface SystemConfigResponse {
  markets: Record<string, any>;
  integrations: {
    telegram: {
      configured: boolean;
      has_bot_token: boolean;
      has_chat_id: boolean;
      chat_count: number;
    };
    shioaji: {
      has_api_key: boolean;
      has_secret_key: boolean;
      production: boolean;
      note: string;
    };
    tradingview_scanner: { enabled: boolean; protocol: string };
    yahoo_adjusted_ohlcv: { enabled: boolean; protocol: string };
    twse_tpex_chips: { enabled: boolean; protocol: string };
  };
  saved_watchlists: Record<
    MarketType,
    { generated_at: string; focus_count: number; benchmark_trend: string } | null
  >;
}
