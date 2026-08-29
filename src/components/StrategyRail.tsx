import { Flask, SquaresFour } from '@phosphor-icons/react';
import type { StrategyDefinition } from '../types';

interface StrategyRailProps {
  strategies: StrategyDefinition[];
  selectedId: string;
  onSelect: (id: string) => void;
}

export function StrategyRail({ strategies, selectedId, onSelect }: StrategyRailProps) {
  return (
    <aside className="strategy-rail">
      <div className="rail-brand">
        <div className="rail-mark">NQ</div>
        <div>
          <strong>Strategy Lab</strong>
          <span>Research workspace</span>
        </div>
      </div>

      <div className="rail-section-label">
        <SquaresFour size={14} weight="bold" />
        Strategies
      </div>

      <div className="strategy-list">
        {strategies.map((strategy) => (
          <div className="strategy-entry" key={strategy.id}>
            <button
              className={`strategy-item ${selectedId === strategy.id ? 'is-active' : ''}`}
              type="button"
              onClick={() => onSelect(strategy.id)}
            >
              <span className="strategy-icon">
                <Flask size={17} />
              </span>
              <span className="strategy-copy">
                <strong>{strategy.name}</strong>
                <span>{strategy.description}</span>
              </span>
              <span className={`strategy-state state-${strategy.state}`}>{strategy.state}</span>
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
