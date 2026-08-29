import { Play, SpinnerGap } from '@phosphor-icons/react';
import type { StrategyDefinition, Timeframe } from '../types';

interface TopbarProps {
  strategies: StrategyDefinition[];
  selectedStrategyId: string;
  onStrategyChange: (value: string) => void;
  timeframe: Timeframe;
  onTimeframeChange: (value: Timeframe) => void;
  start: string;
  end: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  onRun: () => void;
  running: boolean;
  onSelectAll: () => void;
  allDataAvailable: boolean;
  allSelected: boolean;
}

const timeframes: Timeframe[] = ['1m', '5m', '15m', '1h'];

export function Topbar(props: TopbarProps) {
  return (
    <header className="topbar">
      <label className="strategy-picker">
        <span>Strategy Lab</span>
        <select
          value={props.selectedStrategyId}
          onChange={(event) => props.onStrategyChange(event.target.value)}
          aria-label="Select strategy"
        >
          {props.strategies.map((strategy) => (
            <option key={strategy.id} value={strategy.id}>{strategy.name}</option>
          ))}
        </select>
      </label>

      <div className="instrument-block">
        <strong>NQ</strong>
        <span>MNQ P&amp;L</span>
      </div>

      <div className="timeframe-control" aria-label="Chart timeframe">
        {timeframes.map((item) => (
          <button
            className={props.timeframe === item ? 'is-selected' : ''}
            key={item}
            type="button"
            onClick={() => props.onTimeframeChange(item)}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="date-controls">
        <label>
          <span>From</span>
          <input
            type="date"
            value={props.start}
            onChange={(event) => props.onStartChange(event.target.value)}
          />
        </label>
        <label>
          <span>To</span>
          <input
            type="date"
            value={props.end}
            onChange={(event) => props.onEndChange(event.target.value)}
          />
        </label>
        <button
          className={`all-data-button ${props.allSelected ? 'is-selected' : ''}`}
          type="button"
          disabled={!props.allDataAvailable}
          onClick={props.onSelectAll}
          title="Use the complete locally available history"
        >
          All
        </button>
      </div>

      <button className="run-button" type="button" onClick={props.onRun} disabled={props.running}>
        {props.running ? (
          <SpinnerGap className="spin" size={17} weight="bold" />
        ) : (
          <Play size={16} weight="fill" />
        )}
        {props.running ? 'Running' : 'Run test'}
      </button>
    </header>
  );
}
