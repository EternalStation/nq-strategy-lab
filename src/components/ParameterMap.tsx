import { useMemo, useState } from 'react';
import { ChartBar, SpinnerGap } from '@phosphor-icons/react';
import type { OptimizationResult, ParameterKey } from '../types';

interface ParameterMapProps {
  result: OptimizationResult | null;
  running: boolean;
  blockedBy: string | null;
  stopping: boolean;
  onRun: () => void;
  onStop: () => void;
  strategyId: string;
}

const noWickParameterOptions: Array<{ key: ParameterKey; label: string }> = [
  { key: 'stop_loss', label: 'Stop method' },
  { key: 'reward_risk', label: 'Reward-to-risk' },
  { key: 'trend_lookback', label: 'Trend lookback' },
  { key: 'trend_threshold', label: 'Trend threshold' },
  { key: 'range_fraction', label: 'Premium / discount gate' },
  { key: 'trade_window', label: 'New York entry window' },
];

const noWickV2ParameterOptions: Array<{ key: ParameterKey; label: string }> = [
  { key: 'stop_loss', label: 'Stop distance' },
  { key: 'reward_risk', label: 'Reward-to-risk' },
  { key: 'entry_delay_bars', label: 'Entry delay' },
  { key: 'order_expiry', label: 'Order expiry' },
];

function dollars(value: number): string {
  const sign = value < 0 ? '-' : value > 0 ? '+' : '';
  const absolute = Math.abs(value);
  const compact = absolute >= 1_000_000
    ? `${(absolute / 1_000_000).toFixed(1)}m`
    : absolute >= 1_000
      ? `${(absolute / 1_000).toFixed(0)}k`
      : absolute.toFixed(0);
  return `${sign}$${compact}`;
}

export function ParameterMap(props: ParameterMapProps) {
  const [parameter, setParameter] = useState<ParameterKey>('stop_loss');
  const parameterOptions = props.strategyId === 'range-ifvg'
    ? [{ key: 'breakout_mode' as const, label: 'Breakout trigger' }]
    : props.strategyId === 'no-wick-body-v2'
      ? noWickV2ParameterOptions
      : noWickParameterOptions;
  const effectiveParameter = parameterOptions.some((option) => option.key === parameter)
    ? parameter
    : parameterOptions[0].key;
  const buckets = props.result?.parameter_analysis[effectiveParameter] ?? [];
  const model = useMemo(() => {
    const width = 1_000;
    const height = 220;
    const padding = { top: 24, right: 24, bottom: 55, left: 66 };
    const values = buckets.map((bucket) => bucket.total_net_pnl);
    const maximum = Math.max(0, ...values);
    const minimum = Math.min(0, ...values);
    const range = maximum - minimum || 1;
    const innerHeight = height - padding.top - padding.bottom;
    const zeroY = padding.top + (maximum / range) * innerHeight;
    const slot = (width - padding.left - padding.right) / Math.max(1, buckets.length);
    const barWidth = Math.min(54, slot * 0.62);
    const bars = buckets.map((bucket, index) => {
      const valueY = padding.top + ((maximum - bucket.total_net_pnl) / range) * innerHeight;
      return {
        ...bucket,
        x: padding.left + index * slot + (slot - barWidth) / 2,
        y: Math.min(zeroY, valueY),
        width: barWidth,
        height: Math.max(1, Math.abs(zeroY - valueY)),
        labelX: padding.left + index * slot + slot / 2,
        positive: bucket.total_net_pnl >= 0,
      };
    });
    return { width, height, padding, maximum, minimum, zeroY, bars };
  }, [buckets]);

  if (!props.result) {
    return (
      <div className="parameter-map-empty">
        <ChartBar size={24} />
        <strong>{props.strategyId === 'range-ifvg' ? 'Compare the breakout triggers' : 'Run the optimizer to build parameter charts'}</strong>
        <span>{props.strategyId === 'range-ifvg'
          ? 'The chart compares wick breakout against one-minute body-close breakout over the selected dates.'
          : 'Every bar aggregates net P&L from all tested combinations using that parameter value.'}</span>
        <button
          type="button"
          onClick={props.running ? props.onStop : props.onRun}
          disabled={props.stopping || Boolean(props.blockedBy)}
        >
          {props.running && <SpinnerGap className="spin" size={14} />}
          {props.stopping
            ? 'Stopping Optimizer…'
            : props.running
              ? 'Stop Optimizer'
              : props.blockedBy
                ? `${props.blockedBy} is running`
                : 'Run Optimizer'}
        </button>
      </div>
    );
  }

  const best = buckets.reduce((winner, bucket) => (
    !winner || bucket.total_net_pnl > winner.total_net_pnl ? bucket : winner
  ), buckets[0]);

  return (
    <div className="parameter-map">
      <div className="parameter-map-header">
        <div>
          <span>Aggregated parameter contribution</span>
          <strong>Total net P&amp;L across all {props.result.tested} tested combinations</strong>
        </div>
        <label>
          <span>Parameter</span>
          <select value={effectiveParameter} onChange={(event) => setParameter(event.target.value as ParameterKey)}>
            {parameterOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
          </select>
        </label>
        {best && <div className="parameter-best"><span>Best aggregate</span><strong>{best.label} · {dollars(best.total_net_pnl)}</strong></div>}
      </div>
      <div className="parameter-chart-wrap">
        <svg className="parameter-chart" viewBox={`0 0 ${model.width} ${model.height}`} role="img" aria-label="Net profit histogram by selected parameter">
          <line x1={model.padding.left} x2={model.width - model.padding.right} y1={model.zeroY} y2={model.zeroY} className="parameter-zero-line" />
          <text x={model.padding.left - 8} y={model.padding.top + 4} textAnchor="end">{dollars(model.maximum)}</text>
          <text x={model.padding.left - 8} y={model.zeroY + 3} textAnchor="end">$0</text>
          <text x={model.padding.left - 8} y={model.height - model.padding.bottom + 3} textAnchor="end">{dollars(model.minimum)}</text>
          {model.bars.map((bar) => (
            <g key={String(bar.value)}>
              <title>{`${bar.label}: ${dollars(bar.total_net_pnl)} total · ${dollars(bar.average_net_pnl)} average · ${bar.tests} tests · ${bar.average_win_rate.toFixed(1)}% average win rate`}</title>
              <rect x={bar.x} y={bar.y} width={bar.width} height={bar.height} rx={3} className={bar.positive ? 'parameter-bar-positive' : 'parameter-bar-negative'} />
              <text x={bar.labelX} y={bar.positive ? bar.y - 6 : bar.y + bar.height + 12} textAnchor="middle" className="parameter-value-label">{dollars(bar.total_net_pnl)}</text>
              <text x={bar.labelX} y={model.height - 25} textAnchor="end" transform={`rotate(-32 ${bar.labelX} ${model.height - 25})`} className="parameter-x-label">{bar.label}</text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
