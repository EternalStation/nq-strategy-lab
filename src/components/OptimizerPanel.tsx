import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, SpinnerGap } from '@phosphor-icons/react';
import type {
  NoWickOptimizationVariation,
  NoWickV2OptimizationVariation,
  OptimizationResult,
  OptimizationVariation,
  RangeIfvgOptimizationVariation,
} from '../types';

type SortKey =
  | 'trend_lookback'
  | 'trend_threshold'
  | 'range_fraction'
  | 'trade_window'
  | 'stop_loss'
  | 'reward_risk'
  | 'net_pnl'
  | 'win_rate'
  | 'total_trades'
  | 'max_drawdown'
  | 'drawdown_net_ratio'
  | 'average_trade';

interface OptimizerPanelProps {
  result: OptimizationResult | null;
  running: boolean;
  blockedBy: string | null;
  stopping: boolean;
  selectedId: string | null;
  onRun: () => void;
  onStop: () => void;
  onSelect: (variation: OptimizationVariation) => void;
  strategyId: string;
}

function OptimizerActionButton(props: {
  className: string;
  running: boolean;
  stopping: boolean;
  blockedBy: string | null;
  onRun: () => void;
  onStop: () => void;
}) {
  return (
    <button
      className={`${props.className}${props.running ? ' is-stop' : ''}`}
      type="button"
      onClick={props.running ? props.onStop : props.onRun}
      disabled={props.stopping || Boolean(props.blockedBy)}
    >
      {props.running && <SpinnerGap className="spin" size={15} />}
      {props.stopping
        ? 'Stopping Optimizer…'
        : props.running
          ? 'Stop Optimizer'
          : props.blockedBy
            ? `${props.blockedBy} is running`
            : 'Run Optimizer'}
    </button>
  );
}

const columns: Array<{ key: SortKey; label: string; descending?: boolean }> = [
  { key: 'trend_lookback', label: 'Trend bars' },
  { key: 'trend_threshold', label: 'Threshold' },
  { key: 'range_fraction', label: 'Range gate' },
  { key: 'trade_window', label: 'NY window' },
  { key: 'stop_loss', label: 'Stop' },
  { key: 'reward_risk', label: 'R:R' },
  { key: 'net_pnl', label: 'Net P&L', descending: true },
  { key: 'win_rate', label: 'Win rate', descending: true },
  { key: 'total_trades', label: 'Trades', descending: true },
  { key: 'max_drawdown', label: 'Max DD' },
  { key: 'drawdown_net_ratio', label: 'DD / Net' },
  { key: 'average_trade', label: 'Avg trade', descending: true },
];

function dollars(value: number): string {
  const sign = value < 0 ? '-' : value > 0 ? '+' : '';
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function tradeWindow(variation: NoWickOptimizationVariation): string {
  const { trade_start_hour: start, trade_end_hour: end } = variation.parameters;
  return `${String(start).padStart(2, '0')}–${String(end).padStart(2, '0')}`;
}

function stopLabel(variation: NoWickOptimizationVariation): string {
  return variation.parameters.stop_mode === 'swing'
    ? 'Swing'
    : `${variation.parameters.stop_points} pt`;
}

function sortValue(variation: NoWickOptimizationVariation, key: SortKey): number | string | null {
  if (key === 'trade_window') return variation.parameters.trade_start_hour * 100 + variation.parameters.trade_end_hour;
  if (key === 'stop_loss') return variation.parameters.stop_mode === 'swing' ? 0 : variation.parameters.stop_points;
  if (key in variation.parameters) {
    return variation.parameters[key as keyof NoWickOptimizationVariation['parameters']] as number;
  }
  return variation.metrics[key as keyof OptimizationVariation['metrics']] as number | null;
}

function VariationCells({ variation }: { variation: NoWickOptimizationVariation }) {
  return (
    <>
      <td>{variation.parameters.trend_lookback}</td>
      <td>{Math.round(variation.parameters.trend_threshold * 100)}%</td>
      <td>{variation.parameters.range_fraction * 100}%</td>
      <td>{tradeWindow(variation)}</td>
      <td>{stopLabel(variation)}</td>
      <td>1:{variation.parameters.reward_risk}</td>
      <td className={variation.metrics.net_pnl >= 0 ? 'positive' : 'negative'}>{dollars(variation.metrics.net_pnl)}</td>
      <td>{variation.metrics.win_rate.toFixed(1)}%</td>
      <td>{variation.metrics.total_trades.toLocaleString()}</td>
      <td>{dollars(-variation.metrics.max_drawdown)}</td>
      <td>{variation.metrics.drawdown_net_ratio !== null && variation.metrics.drawdown_net_ratio !== undefined
        ? `${variation.metrics.drawdown_net_ratio.toFixed(1)}%`
        : 'N/A'}</td>
      <td>{dollars(variation.metrics.average_trade)}</td>
    </>
  );
}

function isNoWickVariation(
  variation: OptimizationVariation,
): variation is NoWickOptimizationVariation {
  return 'trend_lookback' in variation.parameters;
}

function RangeIfvgOptimizerPanel(props: OptimizerPanelProps) {
  const result = props.result?.strategy_id === 'range-ifvg' ? props.result : null;
  if (!result) {
    return (
      <div className="optimizer-empty">
        <div className="optimizer-kicker">Breakout comparison</div>
        <strong>Test wick against body close</strong>
        <p>Runs the same Range iFVG rules twice over the selected dates and changes only what confirms the first range breakout.</p>
        <div className="optimizer-ranges">
          <span>Wick beyond range</span><span>1m close beyond range</span>
        </div>
        <OptimizerActionButton className="optimizer-run" {...props} />
      </div>
    );
  }

  const variations = result.variations
    .filter((variation): variation is RangeIfvgOptimizationVariation => (
      'breakout_mode' in variation.parameters
    ))
    .sort((left, right) => right.metrics.net_pnl - left.metrics.net_pnl);

  return (
    <div className="optimizer-panel">
      <div className="optimizer-summary">
        <div><span>Tested</span><strong>{result.tested}</strong></div>
        <div><span>Compared</span><strong>{result.returned}</strong></div>
        <div><span>Changed</span><strong>Breakout only</strong></div>
        <div><span>Bars each</span><strong>{result.range.bars.toLocaleString()}</strong></div>
        <OptimizerActionButton className="optimizer-rerun" {...props} />
      </div>
      <div className="optimizer-top-list">
        <table className="optimizer-table">
          <thead>
            <tr>
              <th>Rank</th><th>Breakout</th><th>Net P&amp;L</th><th>Win rate</th>
              <th>Trades</th><th>Max DD</th><th>DD / Net</th><th>Avg trade</th>
            </tr>
          </thead>
          <tbody>
            {variations.map((variation, index) => (
              <tr
                key={variation.id}
                className={props.selectedId === variation.id ? 'is-selected' : ''}
                tabIndex={0}
                onClick={() => props.onSelect(variation)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') props.onSelect(variation);
                }}
              >
                <td>#{index + 1}</td>
                <td>{variation.parameters.breakout_mode === 'wick' ? 'Wick' : 'Body close'}</td>
                <td className={variation.metrics.net_pnl >= 0 ? 'positive' : 'negative'}>{dollars(variation.metrics.net_pnl)}</td>
                <td>{variation.metrics.win_rate.toFixed(1)}%</td>
                <td>{variation.metrics.total_trades.toLocaleString()}</td>
                <td>{dollars(-variation.metrics.max_drawdown)}</td>
                <td>{variation.metrics.drawdown_net_ratio !== null && variation.metrics.drawdown_net_ratio !== undefined
                  ? `${variation.metrics.drawdown_net_ratio.toFixed(1)}%`
                  : 'N/A'}</td>
                <td>{dollars(variation.metrics.average_trade)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function isNoWickV2Variation(
  variation: OptimizationVariation,
): variation is NoWickV2OptimizationVariation {
  return 'v2_entry_delay_bars' in variation.parameters;
}

function v2Expiry(variation: NoWickV2OptimizationVariation): string {
  return variation.parameters.v2_order_expiry_mode === 'next_signal'
    ? 'Next signal'
    : `${variation.parameters.v2_order_expiry_bars} bars`;
}

type V2SortKey =
  | 'stop_loss'
  | 'reward_risk'
  | 'entry_delay_bars'
  | 'order_expiry'
  | 'net_pnl'
  | 'win_rate'
  | 'total_trades'
  | 'max_drawdown'
  | 'drawdown_net_ratio'
  | 'average_trade';

const v2Columns: Array<{ key: V2SortKey; label: string; descending?: boolean }> = [
  { key: 'stop_loss', label: 'Stop' },
  { key: 'reward_risk', label: 'R:R' },
  { key: 'entry_delay_bars', label: 'Delay' },
  { key: 'order_expiry', label: 'Expiry' },
  { key: 'net_pnl', label: 'Net P&L', descending: true },
  { key: 'win_rate', label: 'Win rate', descending: true },
  { key: 'total_trades', label: 'Trades', descending: true },
  { key: 'max_drawdown', label: 'Max DD' },
  { key: 'drawdown_net_ratio', label: 'DD / Net' },
  { key: 'average_trade', label: 'Avg trade', descending: true },
];

function v2SortValue(variation: NoWickV2OptimizationVariation, key: V2SortKey): number | null {
  if (key === 'stop_loss') return variation.parameters.v2_stop_points;
  if (key === 'reward_risk') return variation.parameters.v2_reward_risk;
  if (key === 'entry_delay_bars') return variation.parameters.v2_entry_delay_bars;
  if (key === 'order_expiry') {
    return variation.parameters.v2_order_expiry_mode === 'next_signal'
      ? 21
      : variation.parameters.v2_order_expiry_bars;
  }
  return variation.metrics[key] as number | null;
}

function NoWickV2OptimizerPanel(props: OptimizerPanelProps) {
  const result = props.result?.strategy_id === 'no-wick-body-v2' ? props.result : null;
  const [sortKey, setSortKey] = useState<V2SortKey>('net_pnl');
  const [descending, setDescending] = useState(true);
  const sorted = useMemo(() => {
    if (!result) return [];
    return result.variations.filter(isNoWickV2Variation).sort((left, right) => {
      const leftValue = v2SortValue(left, sortKey);
      const rightValue = v2SortValue(right, sortKey);
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      const delta = leftValue - rightValue;
      return descending ? -delta : delta;
    }).slice(0, 20);
  }, [descending, result, sortKey]);
  const activeColumn = v2Columns.find((column) => column.key === sortKey)!;
  const changeSort = (column: (typeof v2Columns)[number]) => {
    if (column.key === sortKey) setDescending((value) => !value);
    else {
      setSortKey(column.key);
      setDescending(Boolean(column.descending));
    }
  };

  if (!result) {
    return (
      <div className="optimizer-empty">
        <div className="optimizer-kicker">Parameter search</div>
        <strong>Find the top 20 for every metric</strong>
        <p>Tests 500 representative settings, preserves each metric’s leaders, and keeps the table focused on the best 20 for your current sort.</p>
        <div className="optimizer-ranges">
          <span>1–5 pt stops</span><span>1:3–1:10 R:R</span><span>0–5-bar delay</span><span>5–20 bars + next signal</span><span>20:00–16:00 NY</span>
        </div>
        <OptimizerActionButton className="optimizer-run" {...props} />
      </div>
    );
  }

  return (
    <div className="optimizer-panel">
      <div className="optimizer-summary">
        <div><span>Tested</span><strong>{result.tested}</strong></div>
        <div><span>Shortlisted</span><strong>{result.returned}</strong></div>
        <div><span>Showing</span><strong>Top 20 · {activeColumn.label}</strong></div>
        <div><span>Bars each</span><strong>{result.range.bars.toLocaleString()}</strong></div>
        <OptimizerActionButton className="optimizer-rerun" {...props} />
      </div>
      <div className="optimizer-top-list">
        <table className="optimizer-table">
          <thead>
            <tr>
              <th>Rank</th>
              {v2Columns.map((column) => (
                <th key={column.key}>
                  <button
                    type="button"
                    onClick={() => changeSort(column)}
                    title={column.key === 'drawdown_net_ratio'
                      ? 'Maximum drawdown divided by positive net P&L. Lower is better.'
                      : `Sort by ${column.label}`}
                  >
                    {column.label}
                    {sortKey === column.key && (descending ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{sorted.map((variation, index) => (
            <tr key={variation.id} className={props.selectedId === variation.id ? 'is-selected' : ''} tabIndex={0} onClick={() => props.onSelect(variation)} onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') props.onSelect(variation);
            }}>
              <td>#{index + 1}</td><td>{variation.parameters.v2_stop_points} pt</td><td>1:{variation.parameters.v2_reward_risk}</td><td>{variation.parameters.v2_entry_delay_bars === 0 ? 'Next bar' : `${variation.parameters.v2_entry_delay_bars} bar`}</td><td>{v2Expiry(variation)}</td>
              <td className={variation.metrics.net_pnl >= 0 ? 'positive' : 'negative'}>{dollars(variation.metrics.net_pnl)}</td><td>{variation.metrics.win_rate.toFixed(1)}%</td><td>{variation.metrics.total_trades.toLocaleString()}</td><td>{dollars(-variation.metrics.max_drawdown)}</td><td>{variation.metrics.drawdown_net_ratio !== null && variation.metrics.drawdown_net_ratio !== undefined ? `${variation.metrics.drawdown_net_ratio.toFixed(1)}%` : 'N/A'}</td><td>{dollars(variation.metrics.average_trade)}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="optimizer-worst">
        <div className="optimizer-worst-title"><span>Bottom 5</span><strong>Worst net-P&amp;L combinations</strong></div>
        <div className="optimizer-worst-grid">
          {result.worst_variations.filter(isNoWickV2Variation).map((variation, index) => (
            <button type="button" key={variation.id} onClick={() => props.onSelect(variation)}>
              <span>#{index + 1} worst · {v2Expiry(variation)}</span>
              <strong className="negative">{dollars(variation.metrics.net_pnl)}</strong>
              <small>{variation.parameters.v2_stop_points} pt stop · 1:{variation.parameters.v2_reward_risk} · {variation.parameters.v2_entry_delay_bars} delayed bars</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function OptimizerPanel(props: OptimizerPanelProps) {
  const [sortKey, setSortKey] = useState<SortKey>('net_pnl');
  const [descending, setDescending] = useState(true);
  const sorted = useMemo(() => {
    if (!props.result) return [];
    return props.result.variations.filter(isNoWickVariation).sort((a, b) => {
      const aValue = sortValue(a, sortKey);
      const bValue = sortValue(b, sortKey);
      if (aValue === null) return 1;
      if (bValue === null) return -1;
      const delta = typeof aValue === 'string' && typeof bValue === 'string'
        ? aValue.localeCompare(bValue)
        : Number(aValue) - Number(bValue);
      if (delta === 0 && sortKey === 'stop_loss') {
        return b.metrics.net_pnl - a.metrics.net_pnl;
      }
      return descending ? -delta : delta;
    }).slice(0, 20);
  }, [descending, props.result, sortKey]);

  const changeSort = (column: (typeof columns)[number]) => {
    if (column.key === sortKey) setDescending((value) => !value);
    else {
      setSortKey(column.key);
      setDescending(Boolean(column.descending));
    }
  };

  if (props.strategyId === 'range-ifvg') {
    return <RangeIfvgOptimizerPanel {...props} />;
  }
  if (props.strategyId === 'no-wick-body-v2') {
    return <NoWickV2OptimizerPanel {...props} />;
  }

  if (!props.result) {
    return (
      <div className="optimizer-empty">
        <div className="optimizer-kicker">Parameter search</div>
        <strong>Find the top 20 for every metric</strong>
        <p>Tests 500 representative settings, preserves each metric’s leaders, and keeps the table focused on the best 20 for your current sort.</p>
        <div className="optimizer-ranges">
          <span>12-30 bars, step 2</span><span>60-80%</span><span>5 Fib gates</span><span>Swing + 15-50 pt stops</span><span>1:2-1:5 R:R</span><span>5 NY windows</span>
        </div>
        <OptimizerActionButton className="optimizer-run" {...props} />
      </div>
    );
  }

  return (
    <div className="optimizer-panel">
      <div className="optimizer-summary">
        <div><span>Tested</span><strong>{props.result.tested}</strong></div>
        <div><span>Shortlisted</span><strong>{props.result.returned}</strong></div>
        <div><span>Showing</span><strong>Top 20</strong></div>
        <div><span>Bars each</span><strong>{props.result.range.bars.toLocaleString()}</strong></div>
        <OptimizerActionButton className="optimizer-rerun" {...props} />
      </div>
      <div className="optimizer-top-list">
        <table className="optimizer-table">
          <thead>
            <tr>
              <th>Rank</th>
              {columns.map((column) => (
                <th key={column.key}>
                  <button
                    type="button"
                    onClick={() => changeSort(column)}
                    title={column.key === 'drawdown_net_ratio'
                      ? 'Maximum drawdown divided by positive net P&L. Lower is better.'
                      : `Sort by ${column.label}`}
                  >
                    {column.label}
                    {sortKey === column.key && (descending ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((variation, index) => (
              <tr
                key={variation.id}
                className={props.selectedId === variation.id ? 'is-selected' : ''}
                tabIndex={0}
                onClick={() => props.onSelect(variation)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') props.onSelect(variation);
                }}
              >
                <td>#{index + 1}</td>
                <VariationCells variation={variation} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="optimizer-worst">
        <div className="optimizer-worst-title"><span>Bottom 5</span><strong>Worst net-P&amp;L combinations</strong></div>
        <div className="optimizer-worst-grid">
          {props.result.worst_variations.filter(isNoWickVariation).map((variation, index) => (
            <button type="button" key={variation.id} onClick={() => props.onSelect(variation)}>
              <span>#{index + 1} worst · {tradeWindow(variation)} NY</span>
              <strong className="negative">{dollars(variation.metrics.net_pnl)}</strong>
              <small>{variation.parameters.trend_lookback} bars · {Math.round(variation.parameters.trend_threshold * 100)}% trend · {variation.parameters.range_fraction * 100}% range · {stopLabel(variation)} · 1:{variation.parameters.reward_risk}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
