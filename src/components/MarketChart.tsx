import { useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, GearSix, SkipBack, SkipForward } from '@phosphor-icons/react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineStyle,
  TickMarkType,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle, Trade } from '../types';

interface MarketChartProps {
  candles: Candle[];
  focusTrade: Trade | null;
  loading: boolean;
  onPreviousTrade?: () => void;
  onNextTrade?: () => void;
  onJumpTo: (utcTime: string) => void;
}

interface ChartPreferences {
  background: string;
  upColor: string;
  downColor: string;
  verticalGrid: boolean;
  horizontalGrid: boolean;
}

const defaultPreferences: ChartPreferences = {
  background: '#0e1317',
  upColor: '#63c28b',
  downColor: '#3b3b3b',
  verticalGrid: false,
  horizontalGrid: false,
};

const NEW_YORK_TIME_ZONE = 'America/New_York';

function savedPreferences(): ChartPreferences {
  try {
    const saved = window.localStorage.getItem('nq-chart-preferences-v6');
    if (saved) return { ...defaultPreferences, ...JSON.parse(saved) };
    const previous = window.localStorage.getItem('nq-chart-preferences-v5')
      ?? window.localStorage.getItem('nq-chart-preferences-v4')
      ?? window.localStorage.getItem('nq-chart-preferences-v3')
      ?? window.localStorage.getItem('nq-chart-preferences-v2');
    return previous
      ? { ...defaultPreferences, ...JSON.parse(previous), upColor: '#63c28b', downColor: '#3b3b3b' }
      : defaultPreferences;
  } catch {
    return defaultPreferences;
  }
}

function dateForChart(time: Time): Date {
  if (typeof time === 'number') return new Date(time * 1_000);
  if (typeof time === 'string') return new Date(`${time}T00:00:00Z`);
  return new Date(Date.UTC(time.year, time.month - 1, time.day));
}

function newYorkLocalToUtc(value: string): string {
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  let guess = desired;
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    guess += desired - represented;
  }
  return new Date(guess).toISOString();
}

export function MarketChart({
  candles,
  focusTrade,
  loading,
  onPreviousTrade,
  onNextTrade,
  onJumpTo,
}: MarketChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const targetSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const stopSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rangeHighSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rangeLowSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const rangeLevelSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const fvgHighSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const fvgLowSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const markerPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const jumpInputRef = useRef<HTMLInputElement>(null);
  const [preferences, setPreferences] = useState<ChartPreferences>(savedPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [jumpTime, setJumpTime] = useState('');

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: preferences.background },
        textColor: '#78858d',
        fontFamily: 'IBM Plex Mono, Consolas, monospace',
        fontSize: 9,
        panes: { separatorColor: '#253038', separatorHoverColor: '#344149' },
      },
      grid: {
        vertLines: { color: preferences.verticalGrid ? '#182127' : 'transparent' },
        horzLines: { color: preferences.horizontalGrid ? '#182127' : 'transparent' },
      },
      crosshair: {
        vertLine: { color: '#738087', labelBackgroundColor: '#252f35' },
        horzLine: { color: '#738087', labelBackgroundColor: '#252f35' },
      },
      rightPriceScale: {
        borderColor: '#253038',
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: '#253038',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        barSpacing: 7,
        minBarSpacing: 0.5,
        allowBoldLabels: false,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: preferences.upColor,
      downColor: preferences.downColor,
      wickUpColor: preferences.upColor,
      wickDownColor: preferences.downColor,
      borderVisible: true,
      borderUpColor: preferences.upColor,
      borderDownColor: preferences.downColor,
      lastValueVisible: false,
      priceLineVisible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.25 },
    });
    const targetSeries = chart.addSeries(LineSeries, {
      color: '#63c28b',
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const stopSeries = chart.addSeries(LineSeries, {
      color: '#ee7065',
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const rangeHighSeries = chart.addSeries(LineSeries, {
      color: '#65727a',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const rangeLowSeries = chart.addSeries(LineSeries, {
      color: '#65727a',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const rangeLevelSeries = chart.addSeries(LineSeries, {
      color: '#d6a65d',
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const fvgHighSeries = chart.addSeries(LineSeries, {
      color: '#d6a65d',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    const fvgLowSeries = chart.addSeries(LineSeries, {
      color: '#d6a65d',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    targetSeriesRef.current = targetSeries;
    stopSeriesRef.current = stopSeries;
    rangeHighSeriesRef.current = rangeHighSeries;
    rangeLowSeriesRef.current = rangeLowSeries;
    rangeLevelSeriesRef.current = rangeLevelSeries;
    fvgHighSeriesRef.current = fvgHighSeries;
    fvgLowSeriesRef.current = fvgLowSeries;
    markerPluginRef.current = createSeriesMarkers(candleSeries, []);

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      targetSeriesRef.current = null;
      stopSeriesRef.current = null;
      rangeHighSeriesRef.current = null;
      rangeLowSeriesRef.current = null;
      rangeLevelSeriesRef.current = null;
      fvgHighSeriesRef.current = null;
      fvgLowSeriesRef.current = null;
      markerPluginRef.current = null;
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem('nq-chart-preferences-v6', JSON.stringify(preferences));
    const timeLabel = new Intl.DateTimeFormat('en-GB', {
      timeZone: NEW_YORK_TIME_ZONE,
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const yearLabel = new Intl.DateTimeFormat('en-US', { timeZone: NEW_YORK_TIME_ZONE, year: 'numeric' });
    const monthLabel = new Intl.DateTimeFormat('en-US', { timeZone: NEW_YORK_TIME_ZONE, month: 'short', year: '2-digit' });
    const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: NEW_YORK_TIME_ZONE, day: '2-digit', month: 'short' });
    const clockLabel = new Intl.DateTimeFormat('en-GB', { timeZone: NEW_YORK_TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });
    const tickLabel = (time: Time, tickType: TickMarkType) => {
      const date = dateForChart(time);
      if (tickType === TickMarkType.Year) return yearLabel.format(date);
      if (tickType === TickMarkType.Month) return monthLabel.format(date).replace(' ', " '");
      if (tickType === TickMarkType.DayOfMonth) return dayLabel.format(date);
      return clockLabel.format(date);
    };
    chartRef.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: preferences.background } },
      grid: {
        vertLines: { color: preferences.verticalGrid ? '#182127' : 'transparent' },
        horzLines: { color: preferences.horizontalGrid ? '#182127' : 'transparent' },
      },
      localization: { timeFormatter: (time: Time) => timeLabel.format(dateForChart(time)) },
      timeScale: {
        allowBoldLabels: false,
        tickMarkFormatter: (time: Time, tickType: TickMarkType) => tickLabel(time, tickType),
      },
    });
    candleSeriesRef.current?.applyOptions({
      upColor: preferences.upColor,
      downColor: preferences.downColor,
      wickUpColor: preferences.upColor,
      wickDownColor: preferences.downColor,
      borderUpColor: preferences.upColor,
      borderDownColor: preferences.downColor,
      lastValueVisible: false,
      priceLineVisible: false,
    });
  }, [preferences]);

  const candleData = useMemo<CandlestickData<Time>[]>(
    () => candles.map((bar) => ({
      time: bar.time as UTCTimestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    })),
    [candles],
  );

  useEffect(() => {
    if (!candleSeriesRef.current || candleData.length === 0) return;
    candleSeriesRef.current.setData(candleData);
    window.requestAnimationFrame(() => {
      candleSeriesRef.current?.priceScale().applyOptions({ autoScale: true });
      chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
      chartRef.current?.timeScale().fitContent();
    });
  }, [candleData]);

  useEffect(() => {
    if (!markerPluginRef.current) return;
    if (!focusTrade) {
      markerPluginRef.current.setMarkers([]);
      targetSeriesRef.current?.setData([]);
      stopSeriesRef.current?.setData([]);
      rangeHighSeriesRef.current?.setData([]);
      rangeLowSeriesRef.current?.setData([]);
      rangeLevelSeriesRef.current?.setData([]);
      fvgHighSeriesRef.current?.setData([]);
      fvgLowSeriesRef.current?.setData([]);
      return;
    }
    const isLong = focusTrade.side === 'long';
    const markers: SeriesMarker<Time>[] = [
      {
        time: Math.floor(new Date(focusTrade.entry_time).getTime() / 1000) as UTCTimestamp,
        position: 'atPriceMiddle',
        price: focusTrade.entry_price,
        color: isLong ? '#63c28b' : '#ee7065',
        shape: isLong ? 'arrowUp' : 'arrowDown',
        text: `${focusTrade.side.toUpperCase()} ${focusTrade.entry_price.toFixed(2)}`,
      },
      {
        time: Math.floor(new Date(focusTrade.exit_time).getTime() / 1000) as UTCTimestamp,
        position: 'atPriceMiddle',
        price: focusTrade.exit_price,
        color: '#ee7065',
        shape: 'arrowDown',
        text: `EXIT ${focusTrade.exit_price.toFixed(2)}`,
      },
    ];
    if (
      focusTrade.range_end_time
      && focusTrade.range_low !== undefined
      && focusTrade.range_high !== undefined
    ) {
      const rangeMarkerTime = Math.floor(new Date(focusTrade.range_end_time).getTime() / 1000) as UTCTimestamp;
      markers.push(
        {
          time: rangeMarkerTime,
          position: 'atPriceMiddle',
          price: focusTrade.range_high,
          color: '#8f9ca4',
          shape: 'circle',
          text: `HIGH ${focusTrade.range_high.toFixed(2)}`,
        },
        {
          time: rangeMarkerTime,
          position: 'atPriceMiddle',
          price: focusTrade.range_low,
          color: '#8f9ca4',
          shape: 'circle',
          text: `LOW ${focusTrade.range_low.toFixed(2)}`,
        },
      );
      if (focusTrade.range_fraction !== undefined && focusTrade.range_level !== undefined) {
        markers.push({
          time: rangeMarkerTime,
          position: 'atPriceMiddle',
          price: focusTrade.range_level,
          color: '#d6a65d',
          shape: 'circle',
          text: `${focusTrade.range_fraction.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} ${focusTrade.range_level.toFixed(2)}`,
        });
      }
    }
    if (
      focusTrade.stop_mode === 'swing'
      && focusTrade.swing_time
      && focusTrade.swing_price !== null
      && focusTrade.swing_price !== undefined
    ) {
      markers.push({
        time: Math.floor(new Date(focusTrade.swing_time).getTime() / 1000) as UTCTimestamp,
        position: 'atPriceMiddle',
        price: focusTrade.swing_price,
        color: '#ee7065',
        shape: 'circle',
        text: `${isLong ? 'SWING LOW' : 'SWING HIGH'} ${focusTrade.swing_price.toFixed(2)}`,
      });
    }
    if (focusTrade.breakout_time && focusTrade.breakout_side) {
      markers.push({
        time: Math.floor(new Date(focusTrade.breakout_time).getTime() / 1000) as UTCTimestamp,
        position: focusTrade.breakout_side === 'high' ? 'aboveBar' : 'belowBar',
        color: '#8f9ca4',
        shape: 'circle',
        text: `${focusTrade.breakout_side.toUpperCase()} BREAK`,
      });
    }
    if (focusTrade.fvg_created_time && focusTrade.inversion_level !== undefined) {
      markers.push({
        time: Math.floor(new Date(focusTrade.fvg_created_time).getTime() / 1000) as UTCTimestamp,
        position: 'atPriceMiddle',
        price: focusTrade.inversion_level,
        color: '#d6a65d',
        shape: 'circle',
        text: `FVG ${focusTrade.inversion_level.toFixed(2)}`,
      });
    }
    if (focusTrade.stop_anchor_time && focusTrade.stop_anchor_price !== undefined) {
      markers.push({
        time: Math.floor(new Date(focusTrade.stop_anchor_time).getTime() / 1000) as UTCTimestamp,
        position: 'atPriceMiddle',
        price: focusTrade.stop_anchor_price,
        color: '#ee7065',
        shape: 'circle',
        text: `EXTREME ${focusTrade.stop_anchor_price.toFixed(2)}`,
      });
    }
    markerPluginRef.current.setMarkers(markers.sort((a, b) => Number(a.time) - Number(b.time)));
    const entryTime = Math.floor(new Date(focusTrade.entry_time).getTime() / 1000) as UTCTimestamp;
    const rawExitTime = Math.floor(new Date(focusTrade.exit_time).getTime() / 1000);
    const nextCandleTime = candles.find((bar) => bar.time > Number(entryTime))?.time;
    const lineEndTime = (
      rawExitTime > Number(entryTime)
        ? rawExitTime
        : nextCandleTime ?? Number(entryTime) + 60
    ) as UTCTimestamp;
    if (focusTrade.target_price !== undefined) {
      targetSeriesRef.current?.setData([
        { time: entryTime, value: focusTrade.target_price },
        { time: lineEndTime, value: focusTrade.target_price },
      ]);
    } else targetSeriesRef.current?.setData([]);
    if (focusTrade.stop_price !== undefined) {
      stopSeriesRef.current?.setData([
        { time: entryTime, value: focusTrade.stop_price },
        { time: lineEndTime, value: focusTrade.stop_price },
      ]);
    } else stopSeriesRef.current?.setData([]);
    if (
      focusTrade.range_start_time
      && focusTrade.range_end_time
      && focusTrade.range_low !== undefined
      && focusTrade.range_high !== undefined
    ) {
      const rangeStartTime = Math.floor(new Date(focusTrade.range_start_time).getTime() / 1000) as UTCTimestamp;
      const rangeEndTime = Math.floor(new Date(focusTrade.range_end_time).getTime() / 1000) as UTCTimestamp;
      rangeHighSeriesRef.current?.setData([
        { time: rangeStartTime, value: focusTrade.range_high },
        { time: rangeEndTime, value: focusTrade.range_high },
      ]);
      rangeLowSeriesRef.current?.setData([
        { time: rangeStartTime, value: focusTrade.range_low },
        { time: rangeEndTime, value: focusTrade.range_low },
      ]);
      if (focusTrade.range_level !== undefined) {
        rangeLevelSeriesRef.current?.setData([
          { time: rangeStartTime, value: focusTrade.range_level },
          { time: rangeEndTime, value: focusTrade.range_level },
        ]);
      } else rangeLevelSeriesRef.current?.setData([]);
    } else {
      rangeHighSeriesRef.current?.setData([]);
      rangeLowSeriesRef.current?.setData([]);
      rangeLevelSeriesRef.current?.setData([]);
    }
    if (
      focusTrade.fvg_start_time
      && focusTrade.fvg_low !== undefined
      && focusTrade.fvg_high !== undefined
    ) {
      const fvgStartTime = Math.floor(new Date(focusTrade.fvg_start_time).getTime() / 1000) as UTCTimestamp;
      fvgHighSeriesRef.current?.setData([
        { time: fvgStartTime, value: focusTrade.fvg_high },
        { time: entryTime, value: focusTrade.fvg_high },
      ]);
      fvgLowSeriesRef.current?.setData([
        { time: fvgStartTime, value: focusTrade.fvg_low },
        { time: entryTime, value: focusTrade.fvg_low },
      ]);
    } else {
      fvgHighSeriesRef.current?.setData([]);
      fvgLowSeriesRef.current?.setData([]);
    }
    chartRef.current?.timeScale().fitContent();
  }, [candles, focusTrade]);

  const jump = () => {
    const value = jumpInputRef.current?.value || jumpTime;
    if (!value) return;
    onJumpTo(newYorkLocalToUtc(value));
  };

  return (
    <section className="chart-panel">
      <div className="chart-header">
        <div className="chart-toolbar">
          {focusTrade && (
            <div className="focused-trade">
              <span>{focusTrade.id}</span>
              <strong className={focusTrade.pnl >= 0 ? 'positive' : 'negative'}>
                {focusTrade.pnl >= 0 ? '+' : ''}${focusTrade.pnl.toFixed(2)}
              </strong>
            </div>
          )}
          <button type="button" onClick={onPreviousTrade} disabled={!onPreviousTrade} aria-label="Previous trade" title="Previous trade">
            <SkipBack size={15} weight="fill" />
          </button>
          <button type="button" onClick={onNextTrade} disabled={!onNextTrade} aria-label="Next trade" title="Next trade">
            <SkipForward size={15} weight="fill" />
          </button>
          <div className="jump-control">
            <span>NY</span>
            <input ref={jumpInputRef} type="datetime-local" value={jumpTime} onChange={(event) => setJumpTime(event.target.value)} aria-label="Jump to New York date and time" />
            <button type="button" onClick={jump} aria-label="Jump to New York time" title="Jump to New York time">
              <Crosshair size={15} />
            </button>
          </div>
          <button
            className={settingsOpen ? 'is-active' : ''}
            type="button"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-label="Chart settings"
            title="Chart settings"
          >
            <GearSix size={16} />
          </button>
        </div>
      </div>
      {settingsOpen && (
        <div className="chart-settings">
          <div className="chart-settings-title">
            <strong>Chart settings</strong>
            <span>Saved automatically</span>
          </div>
          <label>
            <span>Canvas</span>
            <input type="color" value={preferences.background} onChange={(event) => setPreferences({ ...preferences, background: event.target.value })} />
          </label>
          <label>
            <span>Up candle</span>
            <input type="color" value={preferences.upColor} onChange={(event) => setPreferences({ ...preferences, upColor: event.target.value })} />
          </label>
          <label>
            <span>Down candle</span>
            <input type="color" value={preferences.downColor} onChange={(event) => setPreferences({ ...preferences, downColor: event.target.value })} />
          </label>
          <div className="chart-timezone-setting"><span>Time zone</span><strong>New York</strong></div>
          <label className="toggle-setting">
            <input type="checkbox" checked={preferences.verticalGrid} onChange={(event) => setPreferences({ ...preferences, verticalGrid: event.target.checked })} />
            <span>Vertical grid</span>
          </label>
          <label className="toggle-setting">
            <input type="checkbox" checked={preferences.horizontalGrid} onChange={(event) => setPreferences({ ...preferences, horizontalGrid: event.target.checked })} />
            <span>Horizontal grid</span>
          </label>
        </div>
      )}
      <div className="chart-canvas" ref={containerRef} />
      {loading && <div className="chart-loading">Loading candles</div>}
      {!loading && candles.length === 0 && <div className="chart-empty">No candles in this range</div>}
    </section>
  );
}
