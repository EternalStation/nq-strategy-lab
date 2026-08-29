import type { Metrics } from '../types';

interface PerformanceStripProps {
  metrics: Metrics | null;
}

function dollars(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function PerformanceStrip({ metrics }: PerformanceStripProps) {
  const values = [
    { label: 'Net P&L', value: metrics ? dollars(metrics.net_pnl) : 'Waiting', tone: metrics?.net_pnl },
    { label: 'Trades', value: metrics ? metrics.total_trades.toLocaleString() : '0' },
    { label: 'Win rate', value: metrics ? `${metrics.win_rate.toFixed(1)}%` : '0.0%' },
    { label: 'Max drawdown', value: metrics ? dollars(-metrics.max_drawdown) : '$0.00', tone: -1 },
    { label: 'Profit factor', value: metrics?.profit_factor?.toFixed(2) ?? 'N/A' },
    { label: 'Average trade', value: metrics ? dollars(metrics.average_trade) : '$0.00', tone: metrics?.average_trade },
  ];

  return (
    <section className="performance-strip" aria-label="Backtest performance">
      {values.map((item) => (
        <div className="performance-item" key={item.label}>
          <span>{item.label}</span>
          <strong className={item.tone ? (item.tone > 0 ? 'positive' : 'negative') : ''}>{item.value}</strong>
        </div>
      ))}
    </section>
  );
}

