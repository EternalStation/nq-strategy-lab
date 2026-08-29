export type Timeframe = '1m' | '5m' | '15m' | '1h';
export type StrategyId = 'no-wick-body' | 'no-wick-body-v2' | 'range-ifvg';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  instrument_id: number;
  symbol: string;
}

export interface Trade {
  id: string;
  side: 'long' | 'short';
  entry_time: string;
  exit_time: string;
  entry_price: number;
  exit_price: number;
  stop_price?: number;
  target_price?: number;
  stop_mode?: 'fixed' | 'swing' | 'recent-extreme';
  stop_distance?: number;
  swing_time?: string | null;
  swing_price?: number | null;
  swing_age_bars?: number | null;
  setup_time?: string;
  range_start_time?: string;
  range_end_time?: string;
  range_low?: number;
  range_high?: number;
  range_fraction?: number;
  range_level?: number;
  breakout_time?: string;
  breakout_side?: 'high' | 'low';
  breakout_mode?: BreakoutMode;
  fvg_start_time?: string;
  fvg_created_time?: string;
  fvg_low?: number;
  fvg_high?: number;
  inversion_level?: number;
  stop_anchor_time?: string;
  stop_anchor_price?: number;
  contracts: number;
  gross_pnl: number;
  pnl: number;
  duration_minutes: number;
  exit_reason: string;
}

export interface Metrics {
  net_pnl: number;
  total_trades: number;
  win_rate: number;
  max_drawdown: number;
  profit_factor: number | null;
  drawdown_net_ratio?: number | null;
  average_trade: number;
  ending_equity: number;
}

export interface EquityPoint {
  time: number;
  value: number;
  trade_id: string;
  trade_number: number;
  net_pnl: number;
}

export interface BacktestResult {
  strategy_id: string;
  metrics: Metrics;
  trades: Trade[];
  equity_curve: EquityPoint[];
  range: {
    start: string;
    end: string;
    bars: number;
  };
}

export interface NoWickParameters {
  trend_lookback: number;
  trend_threshold: number;
  range_fraction: number;
  stop_mode: 'fixed' | 'swing';
  stop_points: number;
  reward_risk: number;
  trade_start_hour: number;
  trade_end_hour: number;
}

export interface NoWickV2Parameters {
  v2_stop_points: number;
  v2_reward_risk: number;
  v2_entry_delay_bars: number;
  v2_order_expiry_mode: 'bars' | 'next_signal';
  v2_order_expiry_bars: number;
}

export type BreakoutMode = 'wick' | 'close';

export interface RangeIfvgParameters {
  breakout_mode: BreakoutMode;
}

export type StrategyParameters = NoWickParameters | NoWickV2Parameters | RangeIfvgParameters;

export interface ParameterBucket {
  value: string | number;
  label: string;
  tests: number;
  total_net_pnl: number;
  average_net_pnl: number;
  average_win_rate: number;
  total_trades: number;
}

export type ParameterKey =
  | 'breakout_mode'
  | 'trend_lookback'
  | 'trend_threshold'
  | 'range_fraction'
  | 'stop_loss'
  | 'reward_risk'
  | 'trade_window'
  | 'entry_delay_bars'
  | 'order_expiry';

export interface NoWickOptimizationVariation {
  id: string;
  parameters: NoWickParameters;
  metrics: Metrics;
}

export interface RangeIfvgOptimizationVariation {
  id: string;
  parameters: RangeIfvgParameters;
  metrics: Metrics;
}

export interface NoWickV2OptimizationVariation {
  id: string;
  parameters: NoWickV2Parameters;
  metrics: Metrics;
}

export type OptimizationVariation =
  | NoWickOptimizationVariation
  | NoWickV2OptimizationVariation
  | RangeIfvgOptimizationVariation;

export interface OptimizationResult {
  strategy_id: StrategyId;
  tested: number;
  returned: number;
  search_space: number;
  variations: OptimizationVariation[];
  worst_variations: OptimizationVariation[];
  parameter_analysis: Partial<Record<ParameterKey, ParameterBucket[]>>;
  range: {
    start: string;
    end: string;
    bars: number;
  };
}

export interface Coverage {
  source: 'demo' | 'databento';
  status: string;
  symbol: string;
  timeframe: string;
  start: string | null;
  end: string | null;
  bars: number;
  file_size_bytes: number;
  quality?: {
    available: number;
    degraded: number;
    missing: number;
    pending: number;
  } | null;
}

export interface StrategyDefinition {
  id: string;
  name: string;
  description: string;
  state: 'sample' | 'strategy';
  rules: string[];
  contracts: number;
  commissionPerSide: number;
  slippageTicksPerSide: number;
  optimizer?: boolean;
}
