import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from '@phosphor-icons/react';
import type { Trade } from '../types';

interface TradeTableProps {
  trades: Trade[];
  selectedTradeId: string | null;
  onSelect: (trade: Trade) => void;
}

const dateFormat = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/New_York',
});

const PAGE_SIZE = 100;

function duration(value: number): string {
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function TradeTable({ trades, selectedTradeId, onSelect }: TradeTableProps) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(trades.length / PAGE_SIZE));

  useEffect(() => {
    if (!selectedTradeId) return;
    const index = trades.findIndex((trade) => trade.id === selectedTradeId);
    if (index >= 0) setPage(Math.floor(index / PAGE_SIZE));
  }, [selectedTradeId, trades]);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  const visibleTrades = useMemo(
    () => trades.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [page, trades],
  );

  if (trades.length === 0) {
    return <div className="dock-empty">Run a test to populate executions.</div>;
  }
  return (
    <div className="trade-table-wrap">
      <table className="trade-table">
        <thead>
          <tr>
            <th>Trade</th>
            <th>Side</th>
            <th>Entry time (NY)</th>
            <th>Entry</th>
            <th>Exit</th>
            <th>Duration</th>
            <th>P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {visibleTrades.map((trade) => (
            <tr
              className={selectedTradeId === trade.id ? 'is-selected' : ''}
              key={trade.id}
              tabIndex={0}
              onClick={() => onSelect(trade)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelect(trade);
              }}
            >
              <td>{trade.id}</td>
              <td>
                <span className={`side side-${trade.side}`}>
                  {trade.side === 'long' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                  {trade.side}
                </span>
              </td>
              <td>{dateFormat.format(new Date(trade.entry_time))}</td>
              <td>{trade.entry_price.toFixed(2)}</td>
              <td>{trade.exit_price.toFixed(2)}</td>
              <td>{duration(trade.duration_minutes)}</td>
              <td className={trade.pnl >= 0 ? 'positive' : 'negative'}>
                {trade.pnl >= 0 ? '+' : '-'}${Math.abs(trade.pnl).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div className="trade-pagination">
          <span>
            {(page * PAGE_SIZE + 1).toLocaleString()}–{Math.min((page + 1) * PAGE_SIZE, trades.length).toLocaleString()}
            {' '}of {trades.length.toLocaleString()}
          </span>
          <button type="button" onClick={() => setPage((value) => value - 1)} disabled={page === 0} aria-label="Previous trade page">
            <ArrowLeft size={14} />
          </button>
          <strong>{page + 1} / {pageCount}</strong>
          <button type="button" onClick={() => setPage((value) => value + 1)} disabled={page === pageCount - 1} aria-label="Next trade page">
            <ArrowRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
