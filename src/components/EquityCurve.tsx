import { useMemo, useState, type MouseEvent, type PointerEvent } from 'react';
import type { EquityPoint, Trade } from '../types';

interface EquityCurveProps {
  points: EquityPoint[];
  trades: Trade[];
  onTradeSelect: (trade: Trade) => void;
}

const SVG_WIDTH = 1000;
const SVG_HEIGHT = 180;

function money(value: number): string {
  const formatted = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? '-' : ''}$${formatted}`;
}

function axisMoney(value: number): string {
  const absolute = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}M`;
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(absolute >= 100_000 ? 0 : 1)}K`;
  return `${sign}$${absolute.toFixed(0)}`;
}

export function EquityCurve({ points, trades, onTradeSelect }: EquityCurveProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const initialCapital = points[0].value - points[0].net_pnl;
    const values = points.map((point) => point.value - initialCapital);
    let dataMin = values[0];
    let dataMax = values[0];
    for (const value of values) {
      dataMin = Math.min(dataMin, value);
      dataMax = Math.max(dataMax, value);
    }
    let domainMin = Math.min(0, dataMin);
    let domainMax = Math.max(0, dataMax);
    if (domainMax === domainMin) {
      domainMin -= 1;
      domainMax += 1;
    }
    const spread = domainMax - domainMin;
    const coordinate = (index: number) => ({
      x: index / (points.length - 1),
      y: 1 - (values[index] - domainMin) / spread,
      value: values[index],
    });
    const step = Math.max(1, Math.ceil(points.length / 4_000));
    const visibleIndices = points
      .map((_, index) => index)
      .filter((index) => index % step === 0 || index === points.length - 1);
    const path = visibleIndices
      .map((index, pathIndex) => {
        const { x, y } = coordinate(index);
        return `${pathIndex === 0 ? 'M' : 'L'} ${(x * SVG_WIDTH).toFixed(2)} ${(y * SVG_HEIGHT).toFixed(2)}`;
      })
      .join(' ');
    const zeroY = 1 - (0 - domainMin) / spread;
    const yTicks = Array.from({ length: 5 }, (_, index) => {
      const fraction = index / 4;
      return {
        y: fraction,
        value: domainMax - fraction * spread,
      };
    });
    return { path, coordinate, zeroY, yTicks };
  }, [points]);

  const hovered = hoveredIndex === null ? null : points[hoveredIndex];
  const hoveredCoordinate = hovered && geometry
    ? geometry.coordinate(hoveredIndex ?? 0)
    : null;
  const tradeById = useMemo(() => new Map(trades.map((trade) => [trade.id, trade])), [trades]);

  if (!geometry) {
    return <div className="dock-empty">The equity curve appears after at least two closed trades.</div>;
  }

  const indexAtClientX = (clientX: number, target: HTMLDivElement) => {
    const bounds = target.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    return Math.round(fraction * (points.length - 1));
  };

  const trackPointer = (event: PointerEvent<HTMLDivElement>) => {
    setHoveredIndex(indexAtClientX(event.clientX, event.currentTarget));
  };

  const selectAtPointer = (event: MouseEvent<HTMLDivElement>) => {
    const point = points[indexAtClientX(event.clientX, event.currentTarget)];
    const trade = tradeById.get(point.trade_id);
    if (trade) onTradeSelect(trade);
  };

  const xTicks = Array.from({ length: 5 }, (_, index) => {
    const fraction = index / 4;
    return {
      x: fraction,
      trade: Math.max(1, Math.round(1 + fraction * (points.length - 1))),
    };
  });

  return (
    <div className="equity-wrap">
      <div
        className="equity-plot"
        role="img"
        aria-label="Interactive cumulative profit and loss curve"
        onPointerMove={trackPointer}
        onPointerLeave={() => setHoveredIndex(null)}
        onClick={selectAtPointer}
      >
        <svg className="equity-svg" viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="equity-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#b7f34a" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#b7f34a" stopOpacity="0" />
            </linearGradient>
          </defs>
          {geometry.yTicks.map((tick) => (
            <line
              key={tick.y}
              x1="0"
              y1={tick.y * SVG_HEIGHT}
              x2={SVG_WIDTH}
              y2={tick.y * SVG_HEIGHT}
              stroke="#182127"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {xTicks.map((tick) => (
            <line key={tick.trade} x1={tick.x * SVG_WIDTH} y1="0" x2={tick.x * SVG_WIDTH} y2={SVG_HEIGHT} stroke="#182127" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1="0" y1={geometry.zeroY * SVG_HEIGHT} x2={SVG_WIDTH} y2={geometry.zeroY * SVG_HEIGHT} stroke="#3b474d" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d={`${geometry.path} L ${SVG_WIDTH} ${geometry.zeroY * SVG_HEIGHT} L 0 ${geometry.zeroY * SVG_HEIGHT} Z`} fill="url(#equity-fill)" />
          <path d={geometry.path} fill="none" stroke="#b7f34a" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>

        <div className="equity-y-axis" aria-hidden="true">
          {geometry.yTicks.map((tick) => (
            <span key={tick.y} style={{ top: `${tick.y * 100}%` }}>{axisMoney(tick.value)}</span>
          ))}
        </div>
        <div className="equity-x-axis" aria-hidden="true">
          {xTicks.map((tick) => (
            <span key={tick.trade} style={{ left: `${tick.x * 100}%` }}>{tick.trade.toLocaleString()}</span>
          ))}
        </div>

        {hovered && hoveredCoordinate && (
          <>
            <div className="equity-hover-line" style={{ left: `${hoveredCoordinate.x * 100}%` }} />
            <div className="equity-hover-dot" style={{ left: `${hoveredCoordinate.x * 100}%`, top: `${hoveredCoordinate.y * 100}%` }} />
            <div
              className="equity-tooltip"
              style={{
                left: `${Math.max(12, Math.min(88, hoveredCoordinate.x * 100))}%`,
                top: `${Math.max(4, Math.min(58, hoveredCoordinate.y * 100 - 12))}%`,
              }}
            >
              <strong>Trade #{hovered.trade_number.toLocaleString()}</strong>
              <span>Cumulative P&amp;L {money(hoveredCoordinate.value)}</span>
              <span className={hovered.net_pnl >= 0 ? 'positive' : 'negative'}>
                Trade P&amp;L {hovered.net_pnl >= 0 ? '+' : ''}{money(hovered.net_pnl)}
              </span>
              <small>Click to inspect</small>
            </div>
          </>
        )}
      </div>
      <div className="equity-axis-title">Trade number</div>
    </div>
  );
}
