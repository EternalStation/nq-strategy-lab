import { ChartBar, ChartLine, Database, ListBullets, Pulse, SlidersHorizontal } from '@phosphor-icons/react';
import type { Coverage, EquityPoint, OptimizationResult, OptimizationVariation, Trade } from '../types';
import { EquityCurve } from './EquityCurve';
import { OptimizerPanel } from './OptimizerPanel';
import { ParameterMap } from './ParameterMap';
import { TradeTable } from './TradeTable';
import { TradeOutcomeChart } from './TradeOutcomeChart';

export type DockTab = 'trades' | 'equity' | 'outcomes' | 'data' | 'optimizer' | 'parameters';

interface ResultsDockProps {
  activeTab: DockTab;
  onTabChange: (tab: DockTab) => void;
  trades: Trade[];
  equity: EquityPoint[];
  coverage: Coverage | null;
  selectedTradeId: string | null;
  onTradeSelect: (trade: Trade) => void;
  optimizerEnabled: boolean;
  optimization: OptimizationResult | null;
  optimizing: boolean;
  optimizerBlockedBy: string | null;
  stoppingOptimizer: boolean;
  selectedVariationId: string | null;
  onOptimize: () => void;
  onStopOptimizer: () => void;
  onVariationSelect: (variation: OptimizationVariation) => void;
  strategyId: string;
}

function bytes(value: number): string {
  if (!value) return 'In memory';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** power).toFixed(power > 1 ? 1 : 0)} ${units[power]}`;
}

export function ResultsDock(props: ResultsDockProps) {
  return (
    <section className={`results-dock ${props.activeTab === 'optimizer' || props.activeTab === 'parameters' ? 'is-optimizer' : ''}`}>
      <div className="dock-tabs">
        <button className={props.activeTab === 'trades' ? 'is-active' : ''} onClick={() => props.onTabChange('trades')} type="button">
          <ListBullets size={15} /> Trades <span>{props.trades.length}</span>
        </button>
        <button className={props.activeTab === 'equity' ? 'is-active' : ''} onClick={() => props.onTabChange('equity')} type="button">
          <ChartLine size={15} /> Equity
        </button>
        <button className={props.activeTab === 'outcomes' ? 'is-active' : ''} onClick={() => props.onTabChange('outcomes')} type="button">
          <Pulse size={15} /> Trade outcome
        </button>
        <button className={props.activeTab === 'data' ? 'is-active' : ''} onClick={() => props.onTabChange('data')} type="button">
          <Database size={15} /> Data coverage
        </button>
        {props.optimizerEnabled && (
          <button className={props.activeTab === 'optimizer' ? 'is-active' : ''} onClick={() => props.onTabChange('optimizer')} type="button">
            <SlidersHorizontal size={15} /> Optimizer {props.optimization && <span>{props.optimization.returned}</span>}
          </button>
        )}
        {props.optimizerEnabled && (
          <button className={props.activeTab === 'parameters' ? 'is-active' : ''} onClick={() => props.onTabChange('parameters')} type="button">
            <ChartBar size={15} /> Parameter map
          </button>
        )}
      </div>
      <div className="dock-content">
        {props.activeTab === 'trades' && (
          <TradeTable trades={props.trades} selectedTradeId={props.selectedTradeId} onSelect={props.onTradeSelect} />
        )}
        {props.activeTab === 'equity' && (
          <EquityCurve
            points={props.equity}
            trades={props.trades}
            onTradeSelect={props.onTradeSelect}
          />
        )}
        {props.activeTab === 'outcomes' && (
          <TradeOutcomeChart trades={props.trades} onTradeSelect={props.onTradeSelect} />
        )}
        {props.activeTab === 'data' && (
          <div className="coverage-panel">
            <div>
              <span>Source</span>
              <strong>{props.coverage?.source === 'databento' ? 'Databento GLBX.MDP3' : 'Deterministic demo feed'}</strong>
            </div>
            <div>
              <span>Stored bars</span>
              <strong>{props.coverage?.bars.toLocaleString() ?? '0'}</strong>
            </div>
            <div>
              <span>Coverage start</span>
              <strong>{props.coverage?.start ? new Date(props.coverage.start).toLocaleDateString() : 'Pending import'}</strong>
            </div>
            <div>
              <span>Coverage end</span>
              <strong>{props.coverage?.end ? new Date(props.coverage.end).toLocaleDateString() : 'Pending import'}</strong>
            </div>
            <div>
              <span>Local size</span>
              <strong>{bytes(props.coverage?.file_size_bytes ?? 0)}</strong>
            </div>
            <div>
              <span>Derived intervals</span>
              <strong>5m, 15m, 1h</strong>
            </div>
            <div>
              <span>Vendor quality flags</span>
              <strong>
                {props.coverage?.quality
                  ? `${props.coverage.quality.degraded} degraded, ${props.coverage.quality.missing} missing`
                  : 'Pending audit'}
              </strong>
            </div>
          </div>
        )}
        {props.activeTab === 'optimizer' && props.optimizerEnabled && (
          <OptimizerPanel
            result={props.optimization}
            running={props.optimizing}
            blockedBy={props.optimizerBlockedBy}
            stopping={props.stoppingOptimizer}
            selectedId={props.selectedVariationId}
            onRun={props.onOptimize}
            onStop={props.onStopOptimizer}
            onSelect={props.onVariationSelect}
            strategyId={props.strategyId}
          />
        )}
        {props.activeTab === 'parameters' && props.optimizerEnabled && (
          <ParameterMap
            result={props.optimization}
            running={props.optimizing}
            blockedBy={props.optimizerBlockedBy}
            stopping={props.stoppingOptimizer}
            onRun={props.onOptimize}
            onStop={props.onStopOptimizer}
            strategyId={props.strategyId}
          />
        )}
      </div>
    </section>
  );
}
