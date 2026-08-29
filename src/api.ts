import type {
  BacktestResult,
  Candle,
  Coverage,
  OptimizationResult,
  StrategyParameters,
  StrategyId,
  Timeframe,
} from './types';

function responseError(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return fallback;
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => (item && typeof item === 'object' && 'msg' in item
        ? String((item as { msg: unknown }).msg)
        : null))
      .filter((message): message is string => Boolean(message));
    if (messages.length) return messages.join('; ');
  }
  return fallback;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(responseError(payload, response.statusText || 'Request failed'));
  }
  return response.json() as Promise<T>;
}

export async function fetchCoverage(): Promise<Coverage> {
  return readJson(await fetch('/api/coverage'));
}

export async function fetchCandles(
  timeframe: Timeframe,
  start?: string,
  end?: string,
  limit = 3_000,
): Promise<Candle[]> {
  const params = new URLSearchParams({ timeframe, limit: String(limit) });
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  const payload = await readJson<{ candles: Candle[] }>(
    await fetch(`/api/candles?${params.toString()}`),
  );
  return payload.candles;
}

export async function fetchCandlesAround(
  timeframe: Timeframe,
  focusStart: string,
  focusEnd = focusStart,
  limit = 3_000,
  futureBars = 500,
): Promise<Candle[]> {
  const params = new URLSearchParams({
    timeframe,
    focus_start: focusStart,
    focus_end: focusEnd,
    limit: String(limit),
    future_bars: String(futureBars),
  });
  const payload = await readJson<{ candles: Candle[] }>(
    await fetch(`/api/candles?${params.toString()}`),
  );
  return payload.candles;
}

export async function runBacktest(input: {
  timeframe: Timeframe;
  start: string;
  end: string;
  contracts: number;
  commissionPerSide: number;
  slippageTicksPerSide: number;
  strategyId?: string;
  parameters?: StrategyParameters;
}): Promise<BacktestResult> {
  return readJson(
    await fetch('/api/backtests/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strategy_id: input.strategyId ?? 'no-wick-body',
        timeframe: input.timeframe,
        start: input.start,
        end: input.end,
        contracts: input.contracts,
        commission_per_side: input.commissionPerSide,
        slippage_ticks_per_side: input.slippageTicksPerSide,
        initial_capital: 50_000,
        ...input.parameters,
      }),
    }),
  );
}

export async function runOptimization(input: {
  timeframe: Timeframe;
  start: string;
  end: string;
  contracts: number;
  commissionPerSide: number;
  slippageTicksPerSide: number;
  maxVariations?: number;
  strategyId?: StrategyId;
}): Promise<OptimizationResult> {
  return readJson(
    await fetch('/api/backtests/optimize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strategy_id: input.strategyId ?? 'no-wick-body',
        timeframe: input.timeframe,
        start: input.start,
        end: input.end,
        contracts: input.contracts,
        commission_per_side: input.commissionPerSide,
        slippage_ticks_per_side: input.slippageTicksPerSide,
        initial_capital: 50_000,
        max_variations: input.maxVariations ?? 500,
      }),
    }),
  );
}

export async function cancelOptimization(strategyId: StrategyId): Promise<void> {
  await readJson(
    await fetch('/api/backtests/optimize/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy_id: strategyId }),
    }),
  );
}
