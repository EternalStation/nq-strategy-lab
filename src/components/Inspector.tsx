import { Info, X } from '@phosphor-icons/react';
import type { BreakoutMode, StrategyDefinition } from '../types';

interface InspectorProps {
  strategy: StrategyDefinition;
  breakoutMode?: BreakoutMode;
  onBreakoutModeChange?: (mode: BreakoutMode) => void;
  open: boolean;
  onToggle: () => void;
}

export function Inspector(props: InspectorProps) {
  return (
    <div className="inspector-control">
      <button
        className={`inspector-trigger ${props.open ? 'is-active' : ''}`}
        type="button"
        onClick={props.onToggle}
        aria-label="View strategy rules"
        aria-expanded={props.open}
        title="View strategy rules"
      >
        <Info size={17} weight={props.open ? 'fill' : 'regular'} />
      </button>

      {props.open && (
        <aside className="inspector-popover" aria-label={`${props.strategy.name} rules`}>
          <div className="inspector-title">
            <div>
              <span>Strategy rules</span>
              <strong>{props.strategy.name}</strong>
            </div>
            <div className="inspector-title-actions">
              <span className="sample-badge">{props.strategy.state}</span>
              <button type="button" onClick={props.onToggle} aria-label="Close strategy rules" title="Close strategy rules">
                <X size={15} />
              </button>
            </div>
          </div>

          {props.breakoutMode && props.onBreakoutModeChange && (
            <section className="strategy-parameters">
              <h2>Breakout trigger</h2>
              <div className="segmented-control">
                <button
                  className={props.breakoutMode === 'wick' ? 'is-selected' : ''}
                  type="button"
                  onClick={() => props.onBreakoutModeChange?.('wick')}
                >
                  Wick
                </button>
                <button
                  className={props.breakoutMode === 'close' ? 'is-selected' : ''}
                  type="button"
                  onClick={() => props.onBreakoutModeChange?.('close')}
                >
                  Body close
                </button>
              </div>
            </section>
          )}

          <section className="rules-section">
            <h2>Rules</h2>
            <ol>
              {props.strategy.rules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ol>
          </section>
        </aside>
      )}
    </div>
  );
}
