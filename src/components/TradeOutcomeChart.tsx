import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import type { Trade } from '../types';

interface TradeOutcomeChartProps {
  trades: Trade[];
  onTradeSelect: (trade: Trade) => void;
}

interface OutcomePoint {
  trade: Trade;
  streak: number;
  tradeNumber: number;
}

const PLOT_LEFT = 34;
const PLOT_RIGHT = 8;
const PLOT_TOP = 8;
const PLOT_BOTTOM = 20;

function dollars(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function buildOutcomes(trades: Trade[]): OutcomePoint[] {
  const ordered = [...trades].sort(
    (left, right) => new Date(left.entry_time).getTime() - new Date(right.entry_time).getTime(),
  );
  let streak = 0;
  return ordered.map((trade, index) => {
    if (trade.pnl > 0) streak = streak > 0 ? streak + 1 : 1;
    else if (trade.pnl < 0) streak = streak < 0 ? streak - 1 : -1;
    else streak = 0;
    return { trade, streak, tradeNumber: index + 1 };
  });
}

export function TradeOutcomeChart({ trades, onTradeSelect }: TradeOutcomeChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoveredIndexRef = useRef<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const outcomes = useMemo(() => buildOutcomes(trades), [trades]);
  const longestWin = useMemo(
    () => outcomes.reduce((largest, point) => Math.max(largest, point.streak), 0),
    [outcomes],
  );
  const longestLoss = useMemo(
    () => Math.abs(outcomes.reduce((lowest, point) => Math.min(lowest, point.streak), 0)),
    [outcomes],
  );
  const maxStreak = Math.max(1, longestWin, longestLoss);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || outcomes.length === 0) return;

    const draw = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const plotWidth = Math.max(1, width - PLOT_LEFT - PLOT_RIGHT);
      const plotHeight = Math.max(1, height - PLOT_TOP - PLOT_BOTTOM);
      const zeroY = PLOT_TOP + plotHeight / 2;
      const halfHeight = plotHeight / 2 - 5;
      const yFor = (streak: number) => zeroY - (streak / maxStreak) * halfHeight;

      context.strokeStyle = '#182127';
      context.lineWidth = 1;
      for (const fraction of [0, 0.5, 1]) {
        const y = PLOT_TOP + plotHeight * fraction + 0.5;
        context.beginPath();
        context.moveTo(PLOT_LEFT, y);
        context.lineTo(width - PLOT_RIGHT, y);
        context.stroke();
      }
      context.strokeStyle = '#46535a';
      context.beginPath();
      context.moveTo(PLOT_LEFT, zeroY + 0.5);
      context.lineTo(width - PLOT_RIGHT, zeroY + 0.5);
      context.stroke();

      const pixels = Math.max(1, Math.floor(plotWidth));
      if (outcomes.length > pixels * 2) {
        for (let pixel = 0; pixel < pixels; pixel += 1) {
          const from = Math.floor((pixel / pixels) * outcomes.length);
          const to = Math.max(from + 1, Math.floor(((pixel + 1) / pixels) * outcomes.length));
          let positive = 0;
          let negative = 0;
          for (let index = from; index < to; index += 1) {
            positive = Math.max(positive, outcomes[index].streak);
            negative = Math.min(negative, outcomes[index].streak);
          }
          const x = PLOT_LEFT + pixel + 0.5;
          if (positive > 0) {
            context.strokeStyle = '#63c28b';
            context.beginPath();
            context.moveTo(x, zeroY);
            context.lineTo(x, yFor(positive));
            context.stroke();
          }
          if (negative < 0) {
            context.strokeStyle = '#ee7065';
            context.beginPath();
            context.moveTo(x, zeroY);
            context.lineTo(x, yFor(negative));
            context.stroke();
          }
        }
      } else {
        const step = plotWidth / outcomes.length;
        const barWidth = Math.max(1, step * 0.72);
        outcomes.forEach((point, index) => {
          const x = PLOT_LEFT + index * step + (step - barWidth) / 2;
          const y = yFor(point.streak);
          context.fillStyle = point.streak >= 0 ? '#63c28b' : '#ee7065';
          context.fillRect(x, Math.min(zeroY, y), barWidth, Math.max(1, Math.abs(zeroY - y)));
        });
      }

      context.fillStyle = '#65727a';
      context.font = '8px IBM Plex Mono, Consolas, monospace';
      context.textBaseline = 'middle';
      context.textAlign = 'right';
      context.fillText(`+${maxStreak}`, PLOT_LEFT - 5, PLOT_TOP + 2);
      context.fillText('0', PLOT_LEFT - 5, zeroY);
      context.fillText(`-${maxStreak}`, PLOT_LEFT - 5, PLOT_TOP + plotHeight - 2);
      context.textBaseline = 'bottom';
      context.textAlign = 'left';
      context.fillText('1', PLOT_LEFT, height - 1);
      context.textAlign = 'right';
      context.fillText(outcomes.length.toLocaleString(), width - PLOT_RIGHT, height - 1);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [maxStreak, outcomes]);

  if (outcomes.length === 0) {
    return <div className="dock-empty">Trade outcomes appear after the first closed trade.</div>;
  }

  const indexAtClientX = (clientX: number, target: HTMLDivElement) => {
    const bounds = target.getBoundingClientRect();
    const plotWidth = Math.max(1, bounds.width - PLOT_LEFT - PLOT_RIGHT);
    const fraction = Math.max(0, Math.min(1, (clientX - bounds.left - PLOT_LEFT) / plotWidth));
    return Math.min(outcomes.length - 1, Math.floor(fraction * outcomes.length));
  };

  const trackPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerX = Math.max(PLOT_LEFT, Math.min(bounds.width - PLOT_RIGHT, event.clientX - bounds.left));
    const tooltipX = Math.max(78, Math.min(bounds.width - 78, pointerX));
    event.currentTarget.style.setProperty('--outcome-hover-x', `${pointerX}px`);
    event.currentTarget.style.setProperty('--outcome-tooltip-x', `${tooltipX}px`);
    const nextIndex = indexAtClientX(event.clientX, event.currentTarget);
    if (nextIndex !== hoveredIndexRef.current) {
      hoveredIndexRef.current = nextIndex;
      setHoveredIndex(nextIndex);
    }
  };

  const selectAtPointer = (event: MouseEvent<HTMLDivElement>) => {
    onTradeSelect(outcomes[indexAtClientX(event.clientX, event.currentTarget)].trade);
  };

  const hovered = hoveredIndex === null ? null : outcomes[hoveredIndex];

  return (
    <div className="outcome-wrap">
      <div className="outcome-summary">
        <div><span>Longest win streak</span><strong className="positive">+{longestWin}</strong></div>
        <div><span>Longest loss streak</span><strong className="negative">-{longestLoss}</strong></div>
        <div><span>Sequence</span><strong>{outcomes.length.toLocaleString()} trades</strong></div>
        <p>Each bar is the active streak after that trade. Click any bar to inspect it.</p>
      </div>
      <div
        className="outcome-plot"
        role="img"
        aria-label="Interactive signed win and loss streak chart"
        onPointerMove={trackPointer}
        onPointerLeave={() => {
          hoveredIndexRef.current = null;
          setHoveredIndex(null);
        }}
        onClick={selectAtPointer}
      >
        <canvas ref={canvasRef} aria-hidden="true" />
        {hovered && (
          <>
            <div className="outcome-hover-line" />
            <div className="outcome-tooltip">
              <strong>Trade #{hovered.tradeNumber.toLocaleString()}</strong>
              <span className={hovered.streak > 0 ? 'positive' : hovered.streak < 0 ? 'negative' : ''}>
                {hovered.streak > 0 ? `Win streak +${hovered.streak}` : hovered.streak < 0 ? `Loss streak ${hovered.streak}` : 'Break-even'}
              </span>
              <span>Trade P&amp;L {dollars(hovered.trade.pnl)}</span>
              <small>Click to inspect</small>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
