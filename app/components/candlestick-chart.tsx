"use client";

import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createSeriesMarkers,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BacktestTrade } from "@/lib/backtesting/types";
import type { CandleReadingResult } from "@/lib/candle-reading/types";
import type { Candle } from "@/lib/candles/types";
import type { TradeSignal } from "@/lib/entry-engine/types";
import type { ContextOverlayVisibility, MarketContextResult } from "@/lib/market-context/types";
import type {
  LiquidityZone,
  MarketMarker,
} from "@/lib/market-structure/types";
import type { MarketSetup } from "@/lib/setup-scanner/types";

type TooltipCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
};

type CandlestickChartProps = {
  candles: Candle[];
  markers: MarketMarker[];
  liquidityZones: LiquidityZone[];
  loading: boolean;
  error: string | null;
  hasFetched: boolean;
  visibleRange: string;
  showTooltips: boolean;
  candleReading: CandleReadingResult | null;
  marketContext: MarketContextResult;
  contextOverlays: ContextOverlayVisibility;
  setups: MarketSetup[];
  showSetupOverlays: boolean;
  signals: TradeSignal[];
  showSignalOverlays: boolean;
  selectedSignalId: string | null;
  backtestTrades: BacktestTrade[];
  selectedBacktestTradeId: string | null;
  onMarkerHover: (marker: MarketMarker | null) => void;
  onSignalHover: (signal: TradeSignal | null) => void;
  onVisibleRangeChange: (value: string) => void;
};

function CandlestickChartComponent({
  candles,
  markers,
  liquidityZones,
  loading,
  error,
  hasFetched,
  visibleRange,
  showTooltips,
  candleReading,
  marketContext,
  contextOverlays,
  setups,
  showSetupOverlays,
  signals,
  showSignalOverlays,
  selectedSignalId,
  backtestTrades,
  selectedBacktestTradeId,
  onMarkerHover,
  onSignalHover,
  onVisibleRangeChange,
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const markerPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markerMapRef = useRef<Map<string, MarketMarker>>(new Map());
  const signalMapRef = useRef<Map<string, TradeSignal>>(new Map());
  const showTooltipsRef = useRef(showTooltips);
  const candleReadingRef = useRef(candleReading);
  const marketContextRef = useRef(marketContext);
  const contextOverlaysRef = useRef(contextOverlays);
  const setupsRef = useRef(setups);
  const showSetupOverlaysRef = useRef(showSetupOverlays);
  const [tooltip, setTooltip] = useState<TooltipCandle | null>(null);
  const [analysisZone, setAnalysisZone] = useState<{
    left: number;
    width: number;
  } | null>(null);
  const [contextBands, setContextBands] = useState<{ premiumTop: number; premiumHeight: number; discountTop: number; discountHeight: number } | null>(null);
  const [setupBands, setSetupBands] = useState<Array<{ setup: MarketSetup; top: number; height: number }>>([]);

  const updateAnalysisZone = useCallback(() => {
    const chart = chartRef.current;
    const container = containerRef.current;
    const reading = candleReadingRef.current;
    if (!chart || !container || !reading) {
      setAnalysisZone(null);
      return;
    }

    const start = chart
      .timeScale()
      .timeToCoordinate(
        Math.floor(reading.windowStartTimestamp / 1000) as UTCTimestamp,
      );
    const end = chart
      .timeScale()
      .timeToCoordinate(
        Math.floor(reading.windowEndTimestamp / 1000) as UTCTimestamp,
      );
    if (start === null || end === null) {
      setAnalysisZone(null);
      return;
    }

    const left = Math.max(0, Math.min(start - 5, container.clientWidth));
    const right = Math.max(left, Math.min(end + 6, container.clientWidth));
    setAnalysisZone({ left, width: Math.max(2, right - left) });
  }, []);

  const updateContextBands = useCallback(() => {
    const series = seriesRef.current;
    const context = marketContextRef.current;
    if (!series || !contextOverlaysRef.current.premiumDiscount || !context.premiumDiscount) {
      setContextBands(null);
      return;
    }
    const high = series.priceToCoordinate(context.premiumDiscount.rangeHigh);
    const equilibrium = series.priceToCoordinate(context.premiumDiscount.equilibrium);
    const low = series.priceToCoordinate(context.premiumDiscount.rangeLow);
    if (high === null || equilibrium === null || low === null) {
      setContextBands(null);
      return;
    }
    setContextBands({
      premiumTop: high,
      premiumHeight: Math.max(0, equilibrium - high),
      discountTop: equilibrium,
      discountHeight: Math.max(0, low - equilibrium),
    });
  }, []);

  const updateSetupBands = useCallback(() => {
    const series = seriesRef.current;
    if (!series || !showSetupOverlaysRef.current) {
      setSetupBands([]);
      return;
    }
    const bands = setupsRef.current.slice(0, 4).flatMap((setup) => {
      const topCoordinate = series.priceToCoordinate(setup.setupZone.maxPrice);
      const bottomCoordinate = series.priceToCoordinate(setup.setupZone.minPrice);
      if (topCoordinate === null || bottomCoordinate === null) return [];
      return [{ setup, top: Math.min(topCoordinate, bottomCoordinate), height: Math.max(3, Math.abs(bottomCoordinate - topCoordinate)) }];
    });
    setSetupBands(bands);
  }, []);

  const chartData = useMemo<CandlestickData<Time>[]>(
    () =>
      candles.map((candle) => ({
        time: Math.floor(candle.timestamp / 1000) as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    [candles],
  );
  const markerMap = useMemo(
    () => new Map(markers.map((marker) => [marker.id, marker])),
    [markers],
  );
  const seriesMarkers = useMemo<SeriesMarker<Time>[]>(
    () => [
      ...markers.map(toSeriesMarker),
      ...(showSignalOverlays ? signals.map((signal) => toSignalSeriesMarker(signal, signal.id === selectedSignalId)) : []),
      ...(showSignalOverlays ? backtestTrades.flatMap((trade) => toTradeSeriesMarkers(trade, trade.tradeId === selectedBacktestTradeId)) : []),
    ].sort(sortSeriesMarkers),
    [backtestTrades, markers, selectedBacktestTradeId, selectedSignalId, showSignalOverlays, signals],
  );

  useEffect(() => {
    markerMapRef.current = markerMap;
  }, [markerMap]);

  useEffect(() => {
    signalMapRef.current = new Map(signals.map((signal) => [signal.id, signal]));
  }, [signals]);

  useEffect(() => {
    showTooltipsRef.current = showTooltips;
  }, [showTooltips]);

  useEffect(() => {
    candleReadingRef.current = candleReading;
    const frame = window.requestAnimationFrame(updateAnalysisZone);
    return () => window.cancelAnimationFrame(frame);
  }, [candleReading, updateAnalysisZone]);

  useEffect(() => {
    marketContextRef.current = marketContext;
    contextOverlaysRef.current = contextOverlays;
    const frame = window.requestAnimationFrame(updateContextBands);
    return () => window.cancelAnimationFrame(frame);
  }, [contextOverlays, marketContext, updateContextBands]);

  useEffect(() => {
    setupsRef.current = setups;
    showSetupOverlaysRef.current = showSetupOverlays;
    const frame = window.requestAnimationFrame(updateSetupBands);
    return () => window.cancelAnimationFrame(frame);
  }, [setups, showSetupOverlays, updateSetupBands]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const container = containerRef.current;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#334155",
      },
      grid: {
        horzLines: { color: "#e5e7eb" },
        vertLines: { color: "#e5e7eb" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: "#cbd5e1",
        scaleMargins: {
          top: 0.12,
          bottom: 0.12,
        },
      },
      timeScale: {
        borderColor: "#cbd5e1",
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;
    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#0f9f6e",
      downColor: "#d64545",
      borderUpColor: "#0f9f6e",
      borderDownColor: "#d64545",
      wickUpColor: "#0f9f6e",
      wickDownColor: "#d64545",
    });

    seriesRef.current = candlestickSeries;
    markerPluginRef.current = createSeriesMarkers(candlestickSeries, [], {
      autoScale: true,
    });

    const resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }

      chart.resize(
        Math.floor(entry.contentRect.width),
        Math.floor(entry.contentRect.height),
      );
      updateAnalysisZone();
      updateContextBands();
      updateSetupBands();
    });

    resizeObserver.observe(container);

    chart.subscribeCrosshairMove((param) => {
      const hoveredId =
        typeof param.hoveredObjectId === "string" ? param.hoveredObjectId : null;
      onMarkerHover(hoveredId ? markerMapRef.current.get(hoveredId) ?? null : null);
      onSignalHover(hoveredId ? signalMapRef.current.get(hoveredId) ?? null : null);

      const data = candlestickSeries
        ? param.seriesData.get(candlestickSeries)
        : undefined;

      if (
        !showTooltipsRef.current ||
        !isTooltipCandle(data) ||
        typeof param.time === "undefined"
      ) {
        setTooltip(null);
        return;
      }

      setTooltip({
        time: formatChartTime(param.time),
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
      });
    });

    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (!range) {
        onVisibleRangeChange("No visible range");
        return;
      }

      onVisibleRangeChange(
        `${formatChartTime(range.from)} - ${formatChartTime(range.to)}`,
      );
      updateAnalysisZone();
    });

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      markerPluginRef.current = null;
      priceLinesRef.current = [];
    };
  }, [onMarkerHover, onSignalHover, onVisibleRangeChange, updateAnalysisZone, updateContextBands, updateSetupBands]);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }

    seriesRef.current.setData(chartData);

    if (chartData.length > 0) {
      chartRef.current?.timeScale().fitContent();
      window.requestAnimationFrame(updateAnalysisZone);
      window.requestAnimationFrame(updateContextBands);
      window.requestAnimationFrame(updateSetupBands);
    }
  }, [chartData, updateAnalysisZone, updateContextBands, updateSetupBands]);

  useEffect(() => {
    markerPluginRef.current?.setMarkers(seriesMarkers);
  }, [seriesMarkers]);

  useEffect(() => {
    if (!selectedSignalId || !chartRef.current || candles.length === 0) {
      return;
    }

    const signal = signals.find((item) => item.id === selectedSignalId);
    if (!signal) {
      return;
    }

    const signalIndex = lowerBoundCandleIndex(candles, signal.timestamp);
    const fromIndex = Math.max(0, signalIndex - 12);
    const toIndex = Math.min(candles.length - 1, signalIndex + 12);
    chartRef.current.timeScale().setVisibleRange({
      from: Math.floor(candles[fromIndex].timestamp / 1000) as UTCTimestamp,
      to: Math.floor(candles[toIndex].timestamp / 1000) as UTCTimestamp,
    });
  }, [candles, selectedSignalId, signals]);

  useEffect(() => {
    if (!selectedBacktestTradeId || !chartRef.current || candles.length === 0) {
      return;
    }

    const trade = backtestTrades.find((item) => item.tradeId === selectedBacktestTradeId);
    if (!trade) {
      return;
    }

    const fromIndex = Math.max(0, trade.entryIndex - 12);
    const toIndex = Math.min(candles.length - 1, (trade.exitIndex ?? trade.entryIndex) + 12);
    chartRef.current.timeScale().setVisibleRange({
      from: Math.floor(candles[fromIndex].timestamp / 1000) as UTCTimestamp,
      to: Math.floor(candles[toIndex].timestamp / 1000) as UTCTimestamp,
    });
  }, [backtestTrades, candles, selectedBacktestTradeId]);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }

    for (const priceLine of priceLinesRef.current) {
      seriesRef.current.removePriceLine(priceLine);
    }

    const liquidityLines = liquidityZones.map((zone) =>
      seriesRef.current!.createPriceLine({
        id: zone.id,
        price: zone.price,
        color: zone.type === "BSL" ? "#b45309" : "#2563eb",
        lineWidth: zone.strength === 3 ? 2 : 1,
        lineStyle: zone.swept ? LineStyle.Dotted : LineStyle.Dashed,
        axisLabelVisible: true,
        title: `${zone.type} ${zone.touches}x${zone.swept ? " swept" : ""}`,
      }),
    );
    const scenarioLines = candleReading
      ? [
          seriesRef.current.createPriceLine({
            id: "reading-previous-high",
            price: candleReading.keyLevels.previousHigh,
            color: "#b45309",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "Prev high",
          }),
          seriesRef.current.createPriceLine({
            id: "reading-previous-low",
            price: candleReading.keyLevels.previousLow,
            color: "#2563eb",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "Prev low",
          }),
          seriesRef.current.createPriceLine({
            id: "reading-previous-midpoint",
            price: candleReading.keyLevels.previousMidpoint,
            color: "#64748b",
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: "Prev midpoint",
          }),
          seriesRef.current.createPriceLine({
            id: "reading-latest-close",
            price: candleReading.keyLevels.latestClose,
            color:
              candleReading.latestCandle.direction === "BULLISH"
                ? "#047857"
                : candleReading.latestCandle.direction === "BEARISH"
                  ? "#b91c1c"
                  : "#475569",
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: `Close ${candleReading.latestCandle.closeStrength.toLowerCase()}`,
          }),
        ]
      : [];

    const contextLines: IPriceLine[] = [];
    const addContextLine = (id: string, price: number | null, color: string, title: string, style = LineStyle.Dashed) => {
      if (price === null) return;
      contextLines.push(seriesRef.current!.createPriceLine({ id, price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };
    if (contextOverlays.dealingRange && marketContext.premiumDiscount) {
      addContextLine("context-range-high", marketContext.premiumDiscount.rangeHigh, "#9f1239", "HTF range high");
      addContextLine("context-equilibrium", marketContext.premiumDiscount.equilibrium, "#475569", "HTF EQ", LineStyle.Dotted);
      addContextLine("context-range-low", marketContext.premiumDiscount.rangeLow, "#047857", "HTF range low");
    }
    if (contextOverlays.nearestLevels) {
      addContextLine("context-nearest-resistance", marketContext.nearestLevels.nearestResistance?.price ?? null, "#be123c", "Nearest R");
      addContextLine("context-nearest-support", marketContext.nearestLevels.nearestSupport?.price ?? null, "#15803d", "Nearest S");
    }
    if (contextOverlays.sessionLevels) {
      addContextLine("context-session-high", marketContext.session.currentSessionHigh, "#7c3aed", "Session high", LineStyle.Dotted);
      addContextLine("context-session-low", marketContext.session.currentSessionLow, "#7c3aed", "Session low", LineStyle.Dotted);
      addContextLine("context-previous-session-high", marketContext.session.previousSessionHigh, "#a855f7", "Prev session high", LineStyle.Dotted);
      addContextLine("context-previous-session-low", marketContext.session.previousSessionLow, "#a855f7", "Prev session low", LineStyle.Dotted);
    }

    const setupLines: IPriceLine[] = [];
    if (showSetupOverlays) {
      for (const setup of setups.slice(0, 4)) {
        const color = setupOverlayColor(setup);
        const style = setup.state === "WATCH" || setup.state === "EXPIRED" ? LineStyle.Dotted : setup.state === "INVALIDATED" ? LineStyle.Dashed : LineStyle.Solid;
        setupLines.push(seriesRef.current.createPriceLine({ id: `${setup.id}:zone`, price: setup.setupZone.midpoint, color, lineWidth: setup.state === "TRIGGER" ? 2 : 1, lineStyle: style, axisLabelVisible: true, title: `${setup.state} ${setup.direction} ${setup.score}` }));
        setupLines.push(seriesRef.current.createPriceLine({ id: `${setup.id}:invalid`, price: setup.invalidationLevel.price, color: "#dc2626", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "Invalidation" }));
        if (setup.targetLiquidity) setupLines.push(seriesRef.current.createPriceLine({ id: `${setup.id}:target`, price: setup.targetLiquidity.price, color: "#0369a1", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: `Target ${setup.targetLiquidity.targetType}` }));
      }
    }

    const signalLines: IPriceLine[] = [];
    if (showSignalOverlays) {
      const selectedSignal = selectedSignalId ? signals.find((signal) => signal.id === selectedSignalId) ?? null : null;
      const lineSignals = uniqueSignals([selectedSignal, ...signals.slice(-3)].filter((signal): signal is TradeSignal => Boolean(signal)));
      for (const signal of lineSignals) {
        const color = signal.direction === "BULLISH" ? "#047857" : "#b91c1c";
        const width = signal.id === selectedSignalId ? 3 : 2;
        signalLines.push(seriesRef.current.createPriceLine({ id: `${signal.id}:entry`, price: signal.entryPrice, color, lineWidth: width, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `${signal.type} ENTRY` }));
        signalLines.push(seriesRef.current.createPriceLine({ id: `${signal.id}:sl`, price: signal.stopLoss, color: "#dc2626", lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "SL" }));
        signalLines.push(seriesRef.current.createPriceLine({ id: `${signal.id}:tp1`, price: signal.takeProfit, color: "#15803d", lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "TP1" }));
        if (signal.takeProfit2 !== null) signalLines.push(seriesRef.current.createPriceLine({ id: `${signal.id}:tp2`, price: signal.takeProfit2, color: "#16a34a", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "TP2" }));
        if (signal.takeProfit3 !== null) signalLines.push(seriesRef.current.createPriceLine({ id: `${signal.id}:tp3`, price: signal.takeProfit3, color: "#22c55e", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "TP3" }));
        signalLines.push(seriesRef.current.createPriceLine({ id: `${signal.id}:invalid`, price: signal.invalidationLevel, color: "#7f1d1d", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: "Signal invalidation" }));
      }
      const selectedTrade = selectedBacktestTradeId ? backtestTrades.find((trade) => trade.tradeId === selectedBacktestTradeId) ?? null : null;
      if (selectedTrade) {
        signalLines.push(seriesRef.current.createPriceLine({ id: `${selectedTrade.tradeId}:bt-entry`, price: selectedTrade.entryPrice, color: "#0891b2", lineWidth: 3, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "BT entry" }));
        signalLines.push(seriesRef.current.createPriceLine({ id: `${selectedTrade.tradeId}:bt-sl`, price: selectedTrade.stopLoss, color: "#dc2626", lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "BT SL" }));
        signalLines.push(seriesRef.current.createPriceLine({ id: `${selectedTrade.tradeId}:bt-tp`, price: selectedTrade.takeProfit, color: "#15803d", lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "BT TP" }));
      }
    }

    priceLinesRef.current = [...liquidityLines, ...scenarioLines, ...contextLines, ...setupLines, ...signalLines];
    window.requestAnimationFrame(updateContextBands);
    window.requestAnimationFrame(updateSetupBands);
  }, [backtestTrades, candleReading, contextOverlays, liquidityZones, marketContext, selectedBacktestTradeId, selectedSignalId, setups, showSetupOverlays, showSignalOverlays, signals, updateContextBands, updateSetupBands]);

  return (
    <section className="flex min-h-[720px] flex-col border border-slate-200 bg-white">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-normal text-slate-700">
            Candlestick Chart
          </h2>
          <p className="mt-1 text-xs text-slate-500">{visibleRange}</p>
          {contextOverlays.contextLabels ? (
            <p className="mt-1 text-xs font-medium text-slate-700">
              HTF {formatLabel(marketContext.htfBias.bias)} {marketContext.htfBias.strength}/100 | {formatLabel(marketContext.regime.regime)}
            </p>
          ) : null}
        </div>
        {tooltip ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-700 sm:grid-cols-5">
            <span className="font-medium text-slate-900">{tooltip.time}</span>
            <span>O {formatPrice(tooltip.open)}</span>
            <span>H {formatPrice(tooltip.high)}</span>
            <span>L {formatPrice(tooltip.low)}</span>
            <span>C {formatPrice(tooltip.close)}</span>
          </div>
        ) : (
          <span className="text-xs text-slate-500">OHLC</span>
        )}
      </div>

      <div className="relative min-h-[660px] flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        {contextBands ? (
          <>
            <div className="pointer-events-none absolute inset-x-0 z-[5] bg-rose-100/15" style={{ top: contextBands.premiumTop, height: contextBands.premiumHeight }} />
            <div className="pointer-events-none absolute inset-x-0 z-[5] bg-emerald-100/15" style={{ top: contextBands.discountTop, height: contextBands.discountHeight }} />
          </>
        ) : null}

        {setupBands.map(({ setup, top, height }, index) => (
          <div
            key={setup.id}
            className="pointer-events-none absolute inset-x-0 z-[6]"
            style={{
              top,
              height,
              borderTop: `${setup.state === "TRIGGER" ? 2 : 1}px ${setup.state === "WATCH" ? "dotted" : "solid"} ${setupOverlayColor(setup)}`,
              borderBottom: `${setup.state === "TRIGGER" ? 2 : 1}px ${setup.state === "WATCH" ? "dotted" : "solid"} ${setupOverlayColor(setup)}`,
              backgroundColor: setupOverlayFill(setup),
              opacity: setup.state === "INVALIDATED" || setup.state === "EXPIRED" ? 0.45 : 1,
            }}
          >
            <span className="absolute right-20 top-0 bg-white/90 px-1 text-[9px] font-bold" style={{ color: setupOverlayColor(setup), transform: `translateY(${index % 2 ? "-100%" : "0"})` }}>
              {setup.state === "INVALIDATED" ? "X " : ""}{formatLabel(setup.type)} {setup.direction} {setup.score}
            </span>
          </div>
        ))}

        {analysisZone && candleReading ? (
          <div
            className="pointer-events-none absolute bottom-7 top-0 z-10 border-x border-cyan-600/40 bg-cyan-100/15"
            style={{ left: analysisZone.left, width: analysisZone.width }}
          >
            <span className="absolute right-full top-1 mr-1 hidden whitespace-nowrap bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-900 sm:block">
              Last {candleReading.analyzedCandleCount} closed candles
            </span>
          </div>
        ) : null}

        {candleReading ? (
          <div className="pointer-events-none absolute left-3 top-3 z-20 max-w-[190px] border border-slate-300 bg-white/95 px-3 py-2 shadow-sm sm:max-w-[220px]">
            <div className="flex items-center gap-2">
              {candleReading.reversalWarning.reversalRisk === "HIGH" ? (
                <span
                  aria-label="High reversal risk"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full bg-amber-500 text-xs font-bold text-white"
                >
                  !
                </span>
              ) : null}
              <span className="text-xs font-semibold text-slate-800">
                Scenario: {formatLabel(candleReading.scenarios.expectedBias)}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-slate-600">
              Latest close {candleReading.latestCandle.closeStrength.toLowerCase()} | confidence {candleReading.scores.confidence.score}/10
            </p>
          </div>
        ) : null}

        {loading ? (
          <StateOverlay title="Loading candles" />
        ) : error ? (
          <StateOverlay title="Fetch failed" detail={error} />
        ) : hasFetched && candles.length === 0 ? (
          <StateOverlay title="No candles returned" />
        ) : !hasFetched ? (
          <StateOverlay title="Ready" />
        ) : null}
      </div>
    </section>
  );
}

export const CandlestickChart = memo(CandlestickChartComponent);

function StateOverlay({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-white/80 px-6 text-center backdrop-blur-[1px]">
      <div>
        <p className="text-sm font-semibold text-slate-800">{title}</p>
        {detail ? <p className="mt-2 text-xs text-red-700">{detail}</p> : null}
      </div>
    </div>
  );
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 5,
  }).format(value);
}

function formatChartTime(time: Time): string {
  if (typeof time === "number") {
    return new Date(time * 1000).toISOString().replace("T", " ").slice(0, 16);
  }

  if (typeof time === "string") {
    return time;
  }

  return `${time.year}-${String(time.month).padStart(2, "0")}-${String(
    time.day,
  ).padStart(2, "0")}`;
}

function isTooltipCandle(value: unknown): value is Omit<TooltipCandle, "time"> {
  return (
    typeof value === "object" &&
    value !== null &&
    "open" in value &&
    "high" in value &&
    "low" in value &&
    "close" in value &&
    typeof value.open === "number" &&
    typeof value.high === "number" &&
    typeof value.low === "number" &&
    typeof value.close === "number"
  );
}

function toSeriesMarker(marker: MarketMarker): SeriesMarker<Time> {
  const time = Math.floor(marker.timestamp / 1000) as UTCTimestamp;
  const shared = {
    id: marker.id,
    time,
    color: markerColor(marker),
    shape: markerShape(marker),
    size: marker.strength,
    text: markerText(marker),
  };

  if (
    marker.type === "SWING_HIGH" ||
    marker.type === "BSL_SWEEP" ||
    marker.type === "SELLERS" ||
    (marker.type === "BOS" && marker.direction === "BEARISH") ||
    (marker.type === "CHOCH" && marker.direction === "BEARISH")
  ) {
    return {
      ...shared,
      position: "aboveBar",
    };
  }

  if (
    marker.type === "SWING_LOW" ||
    marker.type === "SSL_SWEEP" ||
    marker.type === "BUYERS" ||
    (marker.type === "BOS" && marker.direction === "BULLISH") ||
    (marker.type === "CHOCH" && marker.direction === "BULLISH")
  ) {
    return {
      ...shared,
      position: "belowBar",
    };
  }

  return {
    ...shared,
    position: "inBar",
  };
}

function toSignalSeriesMarker(signal: TradeSignal, selected: boolean): SeriesMarker<Time> {
  const bullish = signal.direction === "BULLISH";
  const rapid = signal.type.startsWith("RAPID");
  return {
    id: signal.id,
    time: Math.floor(signal.timestamp / 1000) as UTCTimestamp,
    position: bullish ? "belowBar" : "aboveBar",
    color: selected ? "#0891b2" : bullish ? "#047857" : "#b91c1c",
    shape: bullish ? "arrowUp" : "arrowDown",
    text: `${selected ? "SELECTED " : ""}${rapid ? "FAST " : ""}${signal.type} ${signal.rr.toFixed(1)}R`,
    size: selected ? 3 : rapid ? 2.5 : 2,
  };
}

function toTradeSeriesMarkers(trade: BacktestTrade, selected: boolean): SeriesMarker<Time>[] {
  const entry: SeriesMarker<Time> = {
    id: `${trade.tradeId}:entry`,
    time: Math.floor(trade.entryTime / 1000) as UTCTimestamp,
    position: trade.direction === "BULLISH" ? "belowBar" : "aboveBar",
    color: selected ? "#0891b2" : trade.finalR >= 0 ? "#047857" : "#b91c1c",
    shape: trade.direction === "BULLISH" ? "arrowUp" : "arrowDown",
    text: `${selected ? "SELECTED " : ""}${trade.result} ${trade.finalR.toFixed(2)}R`,
    size: selected ? 3 : 2,
  };
  if (trade.exitTime === null) return [entry];
  return [
    entry,
    {
      id: `${trade.tradeId}:exit`,
      time: Math.floor(trade.exitTime / 1000) as UTCTimestamp,
      position: "inBar",
      color: trade.finalR >= 0 ? "#15803d" : "#dc2626",
      shape: "square",
      text: trade.finalR >= 0 ? "TP/EXIT" : "SL/EXIT",
      size: selected ? 2 : 1.5,
    },
  ];
}

function sortSeriesMarkers(a: SeriesMarker<Time>, b: SeriesMarker<Time>): number {
  const timeA = typeof a.time === "number" ? a.time : 0;
  const timeB = typeof b.time === "number" ? b.time : 0;
  return timeA - timeB;
}

function markerColor(marker: MarketMarker): string {
  if (marker.type === "BUYERS" || marker.direction === "BULLISH") {
    return "#047857";
  }

  if (marker.type === "SELLERS" || marker.direction === "BEARISH") {
    return "#b91c1c";
  }

  if (marker.type === "FVG") {
    return "#7c3aed";
  }

  return "#475569";
}

function markerShape(marker: MarketMarker): SeriesMarker<Time>["shape"] {
  if (marker.type === "SWING_HIGH" || marker.type === "SWING_LOW") {
    return "circle";
  }

  if (marker.type === "BUYERS" || marker.type === "SSL_SWEEP") {
    return "arrowUp";
  }

  if (marker.type === "SELLERS" || marker.type === "BSL_SWEEP") {
    return "arrowDown";
  }

  return "square";
}

function markerText(marker: MarketMarker): string {
  if (marker.type === "MOMENTUM" || marker.type === "DISPLACEMENT") {
    return marker.direction === "BULLISH" ? "M+" : "M-";
  }

  if (marker.type === "SWING_HIGH") {
    return "SH";
  }

  if (marker.type === "SWING_LOW") {
    return "SL";
  }

  return marker.type;
}

function setupOverlayColor(setup: MarketSetup): string {
  if (setup.state === "INVALIDATED") return "#dc2626";
  if (setup.state === "EXPIRED") return "#64748b";
  if (setup.state === "TRIGGER") return setup.direction === "BULLISH" ? "#047857" : "#b91c1c";
  if (setup.state === "SETUP") return "#0891b2";
  return "#b45309";
}

function setupOverlayFill(setup: MarketSetup): string {
  if (setup.state === "INVALIDATED") return "rgba(254, 202, 202, 0.12)";
  if (setup.state === "EXPIRED") return "rgba(203, 213, 225, 0.10)";
  if (setup.state === "TRIGGER") return setup.direction === "BULLISH" ? "rgba(167, 243, 208, 0.20)" : "rgba(254, 202, 202, 0.20)";
  if (setup.state === "SETUP") return "rgba(165, 243, 252, 0.14)";
  return "rgba(253, 230, 138, 0.08)";
}

function formatLabel(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function lowerBoundCandleIndex(candles: Candle[], timestamp: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (candles[middle].timestamp < timestamp) low = middle + 1;
    else high = middle;
  }
  return Math.min(low, candles.length - 1);
}

function uniqueSignals(signals: TradeSignal[]): TradeSignal[] {
  const byId = new Map<string, TradeSignal>();
  for (const signal of signals) byId.set(signal.id, signal);
  return [...byId.values()];
}
