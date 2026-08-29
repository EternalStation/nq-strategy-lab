import { useCallback, useEffect, useMemo, useState } from 'react';
import { WarningCircle, X } from '@phosphor-icons/react';
import { cancelOptimization, fetchCandles, fetchCandlesAround, fetchCoverage, runBacktest, runOptimization } from './api';
import { Inspector } from './components/Inspector';
import { MarketChart } from './components/MarketChart';
import { PerformanceStrip } from './components/PerformanceStrip';
import { ResultsDock } from './components/ResultsDock';
import type { DockTab } from './components/ResultsDock';
import { Topbar } from './components/Topbar';
import type {
  BacktestResult,
  BreakoutMode,
  Candle,
  Coverage,
  NoWickParameters,
  NoWickV2Parameters,
  RangeIfvgParameters,
  OptimizationResult,
  OptimizationVariation,
  StrategyDefinition,
  StrategyId,
  StrategyParameters,
  Timeframe,
  Trade,
} from './types';

const strategies: StrategyDefinition[] = [
  {
    id: 'no-wick-body',
    name: 'No Wick Body',
    description: 'Trend retracement limits',
    state: 'strategy',
    rules: [],
    contracts: 1,
    commissionPerSide: 2.25,
    slippageTicksPerSide: 1,
    optimizer: true,
  },
  {
    id: 'no-wick-body-v2',
    name: 'No Wick Body V2',
    description: 'Wick-only rolling limits',
    state: 'strategy',
    rules: [],
    contracts: 1,
    commissionPerSide: 2.25,
    slippageTicksPerSide: 1,
    optimizer: true,
  },
  {
    id: 'range-ifvg',
    name: 'Range iFVG',
    description: '08:12 sweep and inversion',
    state: 'strategy',
    rules: [],
    contracts: 1,
    commissionPerSide: 2.25,
    slippageTicksPerSide: 1,
    optimizer: true,
  },
];

const defaultNoWickParameters: NoWickParameters = {
  trend_lookback: 12,
  trend_threshold: 0.75,
  range_fraction: 0.625,
  stop_mode: 'swing',
  stop_points: 15,
  reward_risk: 2,
  trade_start_hour: 0,
  trade_end_hour: 15,
};

const defaultRangeIfvgParameters: RangeIfvgParameters = {
  breakout_mode: 'wick',
};

const defaultNoWickV2Parameters: NoWickV2Parameters = {
  v2_stop_points: 2,
  v2_reward_risk: 3,
  v2_entry_delay_bars: 1,
  v2_order_expiry_mode: 'next_signal',
  v2_order_expiry_bars: 5,
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayStart(value: string): string {
  return `${value}T00:00:00Z`;
}

function dayEnd(value: string): string {
  return `${value}T23:59:59Z`;
}

export default function App() {
  const today = useMemo(() => new Date(), []);
  const initialStart = useMemo(() => {
    const value = new Date(today);
    value.setUTCDate(value.getUTCDate() - 7);
    return isoDate(value);
  }, [today]);

  const [selectedStrategyId, setSelectedStrategyId] = useState('range-ifvg');
  const [timeframe, setTimeframe] = useState<Timeframe>('1m');
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(isoDate(today));
  const [candles, setCandles] = useState<Candle[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [focusTrade, setFocusTrade] = useState<Trade | null>(null);
  const [chartAnchor, setChartAnchor] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DockTab>('trades');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [optimizingStrategyId, setOptimizingStrategyId] = useState<StrategyId | null>(null);
  const [stoppingOptimizer, setStoppingOptimizer] = useState(false);
  const [optimization, setOptimization] = useState<OptimizationResult | null>(null);
  const [selectedVariationId, setSelectedVariationId] = useState<string | null>(null);
  const [noWickParameters, setNoWickParameters] = useState(defaultNoWickParameters);
  const [noWickV2Parameters, setNoWickV2Parameters] = useState(defaultNoWickV2Parameters);
  const [rangeIfvgParameters, setRangeIfvgParameters] = useState(defaultRangeIfvgParameters);
  const [chartLoading, setChartLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const selectedStrategy = strategies.find((item) => item.id === selectedStrategyId) ?? strategies[0];
  const inspectorStrategy = useMemo<StrategyDefinition>(() => {
    if (selectedStrategy.id === 'range-ifvg') {
      const breakoutRule = rangeIfvgParameters.breakout_mode === 'wick'
        ? 'The first wick strictly beyond either boundary counts as the breakout.'
        : 'The first one-minute close strictly beyond either boundary counts as the breakout.';
      return {
        ...selectedStrategy,
        rules: [
          'On each New York trading day, measure the high and low of every one-minute candle timestamped from 08:12 through 09:12, inclusive. Skip the day if any of those 61 candles is missing.',
          `${breakoutRule} If one candle breaks both sides, skip the day because one-minute OHLC cannot establish which side broke first.`,
          'After a high breakout, track bullish three-candle fair value gaps (first-candle high below third-candle low). After a low breakout, track bearish gaps (first-candle low above third-candle high). The three candles must be consecutive.',
          'From 09:13 until 11:59 New York, take the first inversion after a gap exists: short when a one-minute candle closes below a bullish gap’s first-candle high; long when it closes above a bearish gap’s first-candle low. Enter at that inversion candle’s close.',
          'For a short, stop at the highest high from the breakout through entry and target the original range low. For a long, stop at the lowest low from the breakout through entry and target the original range high.',
          'The opposite boundary must remain unswept by any wick before entry. Allow at most one entry per New York day and never overlap positions. Flatten every open position at the 12:00 New York candle open if stop or target has not already been reached.',
          'If stop and target are both touched in one later candle, record the stop first. Apply one MNQ contract, commission, and slippage costs on both sides.',
        ],
      };
    }
    if (selectedStrategy.id === 'no-wick-body-v2') {
      const expiryRule = noWickV2Parameters.v2_order_expiry_mode === 'next_signal'
        ? 'Cancel the unfilled limit when the next wickless signal closes, then replace it with that signal’s order.'
        : `Cancel an unfilled limit after ${noWickV2Parameters.v2_order_expiry_bars} candles, unless a newer wickless signal replaces it first.`;
      const delayRule = noWickV2Parameters.v2_entry_delay_bars === 0
        ? 'The limit first becomes active on the next candle.'
        : `Wait ${noWickV2Parameters.v2_entry_delay_bars} complete candle${noWickV2Parameters.v2_entry_delay_bars === 1 ? '' : 's'} after the setup; the limit first becomes active on the candle after that.`;
      return {
        ...selectedStrategy,
        rules: [
          'There is no trend or range filter. A candle with no lower wick creates a buy limit at its body low; a candle with no upper wick creates a sell limit at its body high. Candle colour does not matter.',
          'A candle with neither wick is skipped because one-minute OHLC cannot determine which of its simultaneous opposing limits should be kept.',
          delayRule,
          expiryRule,
          'Create and fill limits only from 20:00 through 15:59 New York. Do not carry an order through the 16:00 close. Flatten every open position at the 16:00 New York candle open.',
          `Use a fixed ${noWickV2Parameters.v2_stop_points}-point stop and a 1:${noWickV2Parameters.v2_reward_risk} target. If both are touched in one candle, record the stop first. Apply commission and slippage on both sides.`,
        ],
      };
    }
    if (selectedStrategy.id !== 'no-wick-body') return selectedStrategy;
    const required = Math.ceil(noWickParameters.trend_lookback * noWickParameters.trend_threshold);
    const thresholdPercent = Math.round(noWickParameters.trend_threshold * 100);
    const rangePercent = noWickParameters.range_fraction * 100;
    const timeWindow = `${String(noWickParameters.trade_start_hour).padStart(2, '0')}:00–${String(noWickParameters.trade_end_hour).padStart(2, '0')}:00 New York`;
    const stopRule = noWickParameters.stop_mode === 'swing'
      ? `Use the most recent confirmed three-candle pivot that is at least five bars older than the no-wick setup. Its middle low must be below both neighboring lows, or its middle high above both neighboring highs. Place the stop four points beyond that pivot and set the target at 1:${noWickParameters.reward_risk} of the actual entry-to-stop distance.`
      : `Place the stop ${noWickParameters.stop_points} points beyond entry and the target at 1:${noWickParameters.reward_risk} reward-to-risk.`;
    return {
      ...selectedStrategy,
      rules: [
        `Classify a trend when at least ${required} of the last ${noWickParameters.trend_lookback} candles (${thresholdPercent}%) close in one direction; dojis count as neither.`,
        `Measure the high-low range of those same ${noWickParameters.trend_lookback} candles and require at least a ${rangePercent}% directional retracement. For longs, 0 starts at the high and 1 ends at the low; for shorts, 0 starts at the low and 1 ends at the high.`,
        'Use both bullish and bearish wickless candles. In an uptrend, stage a buy limit at the low of a candle with no lower wick; in a downtrend, stage a sell limit at the high of a candle with no upper wick.',
        `Allow new setups and fills only from ${timeWindow}. Activate the limit on the next bar and cancel it when the trend or entry window ends.`,
        'Keep only one pending order or open position at a time. Close every position at 16:00 New York if its stop or target has not already been reached.',
        stopRule,
        'If stop and target are both touched in one candle, record the stop first. Apply commission and slippage on both sides.',
      ],
    };
  }, [noWickParameters, noWickV2Parameters, rangeIfvgParameters.breakout_mode, selectedStrategy]);

  const refreshChart = useCallback(async () => {
    setChartLoading(true);
    try {
      const next = await fetchCandles(timeframe, undefined, dayEnd(end), 3_000);
      setCandles(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load candles');
    } finally {
      setChartLoading(false);
    }
  }, [end, timeframe]);

  const loadTradeChart = useCallback(async (trade: Trade) => {
    setChartLoading(true);
    try {
      const next = await fetchCandlesAround(
        timeframe,
        trade.entry_time,
        trade.exit_time,
        3_000,
        500,
      );
      setCandles(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to focus this trade');
    } finally {
      setChartLoading(false);
    }
  }, [timeframe]);

  const executeBacktest = useCallback(async (parameterOverride?: StrategyParameters) => {
    setRunning(true);
    setError(null);
    setFocusTrade(null);
    setChartAnchor(null);
    try {
      const next = await runBacktest({
        timeframe,
        start: dayStart(start),
        end: dayEnd(end),
        contracts: selectedStrategy.contracts,
        commissionPerSide: selectedStrategy.commissionPerSide,
        slippageTicksPerSide: selectedStrategy.slippageTicksPerSide,
        strategyId: selectedStrategy.id,
        parameters: parameterOverride ?? (selectedStrategy.id === 'no-wick-body'
          ? noWickParameters
          : selectedStrategy.id === 'no-wick-body-v2'
            ? noWickV2Parameters
            : selectedStrategy.id === 'range-ifvg'
              ? rangeIfvgParameters
              : undefined),
      });
      setResult(next);
      await refreshChart();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Backtest failed');
    } finally {
      setRunning(false);
    }
  }, [end, noWickParameters, noWickV2Parameters, rangeIfvgParameters, refreshChart, selectedStrategy, start, timeframe]);

  const executeOptimization = useCallback(async () => {
    const strategyId = selectedStrategyId as StrategyId;
    if (optimizingStrategyId) {
      const activeName = strategies.find((item) => item.id === optimizingStrategyId)?.name ?? optimizingStrategyId;
      setError(`${activeName} is already optimizing. Stop it before starting another strategy.`);
      return;
    }
    const strategy = strategies.find((item) => item.id === strategyId)!;
    const optimizationTimeframe = strategyId === 'range-ifvg' || strategyId === 'no-wick-body-v2' ? '1m' : timeframe;
    setOptimizingStrategyId(strategyId);
    setStoppingOptimizer(false);
    setError(null);
    try {
      const next = await runOptimization({
        timeframe: optimizationTimeframe,
        start: dayStart(start),
        end: dayEnd(end),
        contracts: strategy.contracts,
        commissionPerSide: strategy.commissionPerSide,
        slippageTicksPerSide: strategy.slippageTicksPerSide,
        maxVariations: 500,
        strategyId,
      });
      setOptimization(next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Optimization failed';
      if (message !== 'Optimization stopped') setError(message);
    } finally {
      setOptimizingStrategyId(null);
      setStoppingOptimizer(false);
    }
  }, [end, optimizingStrategyId, selectedStrategyId, start, timeframe]);

  const stopOptimization = useCallback(async () => {
    if (!optimizingStrategyId || stoppingOptimizer) return;
    setStoppingOptimizer(true);
    setError(null);
    try {
      await cancelOptimization(optimizingStrategyId);
    } catch (cause) {
      setStoppingOptimizer(false);
      setError(cause instanceof Error ? cause.message : 'Unable to stop optimizer');
    }
  }, [optimizingStrategyId, stoppingOptimizer]);

  useEffect(() => {
    fetchCoverage()
      .then(setCoverage)
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to start the workspace'));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void executeBacktest(), 250);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    setOptimization(null);
    setSelectedVariationId(null);
  }, [end, start, timeframe]);

  useEffect(() => {
    if (focusTrade) void loadTradeChart(focusTrade);
    else if (chartAnchor) void jumpToTime(chartAnchor);
    else void refreshChart();
  }, [end, start, timeframe]);

  const selectTrade = useCallback((trade: Trade) => {
    setChartAnchor(null);
    setFocusTrade(trade);
    void loadTradeChart(trade);
  }, [loadTradeChart]);

  const jumpToTime = useCallback(async (utcTime: string) => {
    setFocusTrade(null);
    setChartAnchor(utcTime);
    setChartLoading(true);
    try {
      const next = await fetchCandlesAround(timeframe, utcTime, utcTime, 3_000, 500);
      setCandles(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to jump to this time');
    } finally {
      setChartLoading(false);
    }
  }, [timeframe]);

  const selectedTradeIndex = focusTrade && result
    ? result.trades.findIndex((trade) => trade.id === focusTrade.id)
    : -1;
  const olderTrade = result?.trades[selectedTradeIndex < 0 ? 0 : selectedTradeIndex + 1];
  const newerTrade = selectedTradeIndex > 0 ? result?.trades[selectedTradeIndex - 1] : undefined;

  const selectAllData = useCallback(() => {
    if (!coverage?.start || !coverage.end) return;
    setFocusTrade(null);
    setChartAnchor(null);
    setStart(coverage.start.slice(0, 10));
    setEnd(coverage.end.slice(0, 10));
  }, [coverage]);

  const selectStrategy = useCallback((id: string) => {
    if (optimizingStrategyId) {
      const activeName = strategies.find((item) => item.id === optimizingStrategyId)?.name ?? optimizingStrategyId;
      setError(`Stop ${activeName} before switching strategies.`);
      return;
    }
    setSelectedStrategyId(id);
    if (id === 'range-ifvg' || id === 'no-wick-body-v2') setTimeframe('1m');
    setResult(null);
    setFocusTrade(null);
    setChartAnchor(null);
    setOptimization(null);
    setSelectedVariationId(null);
    setActiveTab('trades');
    setRulesOpen(false);
  }, [optimizingStrategyId]);

  const changeBreakoutMode = useCallback((mode: BreakoutMode) => {
    setRangeIfvgParameters({ breakout_mode: mode });
    setResult(null);
    setFocusTrade(null);
    setChartAnchor(null);
  }, []);

  const selectVariation = useCallback(async (variation: OptimizationVariation) => {
    if ('breakout_mode' in variation.parameters) {
      setRangeIfvgParameters(variation.parameters);
    } else if ('v2_entry_delay_bars' in variation.parameters) {
      setNoWickV2Parameters(variation.parameters);
    } else {
      setNoWickParameters(variation.parameters);
    }
    setSelectedVariationId(variation.id);
    await executeBacktest(variation.parameters);
    setActiveTab('trades');
  }, [executeBacktest]);

  return (
    <div className="app-shell">
      <main className="workspace">
        <Topbar
          strategies={strategies}
          selectedStrategyId={selectedStrategyId}
          onStrategyChange={selectStrategy}
          timeframe={timeframe}
          onTimeframeChange={setTimeframe}
          start={start}
          end={end}
          onStartChange={(value) => {
            setFocusTrade(null);
            setChartAnchor(null);
            setStart(value);
          }}
          onEndChange={(value) => {
            setFocusTrade(null);
            setChartAnchor(null);
            setEnd(value);
          }}
          onRun={() => void executeBacktest()}
          running={running}
          onSelectAll={selectAllData}
          allDataAvailable={Boolean(coverage?.start && coverage.end)}
          allSelected={Boolean(
            coverage?.start
            && coverage.end
            && start === coverage.start.slice(0, 10)
            && end === coverage.end.slice(0, 10)
          )}
        />

        {error && (
          <div className="error-banner" role="alert">
            <WarningCircle size={17} weight="fill" />
            <span>{error}</span>
            <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}><X size={15} /></button>
          </div>
        )}

        <div className="analysis-grid">
          <MarketChart
            candles={candles}
            focusTrade={focusTrade}
            loading={chartLoading}
            onPreviousTrade={olderTrade ? () => selectTrade(olderTrade) : undefined}
            onNextTrade={newerTrade ? () => selectTrade(newerTrade) : undefined}
            onJumpTo={jumpToTime}
          />
          <Inspector
            strategy={inspectorStrategy}
            open={rulesOpen}
            onToggle={() => setRulesOpen((open) => !open)}
            breakoutMode={selectedStrategy.id === 'range-ifvg'
              ? rangeIfvgParameters.breakout_mode
              : undefined}
            onBreakoutModeChange={selectedStrategy.id === 'range-ifvg'
              ? changeBreakoutMode
              : undefined}
          />
        </div>

        <PerformanceStrip metrics={result?.metrics ?? null} />
        <ResultsDock
          activeTab={activeTab}
          onTabChange={setActiveTab}
          trades={result?.trades ?? []}
          equity={result?.equity_curve ?? []}
          coverage={coverage}
          selectedTradeId={focusTrade?.id ?? null}
          onTradeSelect={selectTrade}
          optimizerEnabled={Boolean(selectedStrategy.optimizer)}
          optimization={optimization}
          optimizing={optimizingStrategyId === selectedStrategy.id}
          optimizerBlockedBy={optimizingStrategyId && optimizingStrategyId !== selectedStrategy.id
            ? strategies.find((item) => item.id === optimizingStrategyId)?.name ?? optimizingStrategyId
            : null}
          stoppingOptimizer={stoppingOptimizer}
          selectedVariationId={selectedVariationId}
          onOptimize={() => void executeOptimization()}
          onStopOptimizer={() => void stopOptimization()}
          onVariationSelect={(variation) => void selectVariation(variation)}
          strategyId={selectedStrategy.id}
        />

        <footer className="app-footer">
          <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a>
        </footer>
      </main>
    </div>
  );
}
