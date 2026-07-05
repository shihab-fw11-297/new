"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { CandleReadingPanel } from "@/app/components/candle-reading-panel";
import { CandlestickChart } from "@/app/components/candlestick-chart";
import { MarketContextDashboard } from "@/app/components/market-context-dashboard";
import { SetupScannerPanel } from "@/app/components/setup-scanner-panel";
import { SignalDebugPanel } from "@/app/components/signal-debug-panel";
import { SignalFunnelPanel } from "@/app/components/signal-funnel-panel";
import { SignalHistoryTable } from "@/app/components/signal-history-table";
import { analyzeCandleReading } from "@/lib/candle-reading/engine";
import { fetchCandles } from "@/lib/candles/api-client";
import type {
  Candle,
  CandleAuditInfo,
  CandleFetchRequest,
  Timeframe,
} from "@/lib/candles/types";
import {
  buildAuditInfo,
  calculateMinMaxPrice,
  detectCandleGaps,
  filterCandlesByDateRange,
  getTimeframeMs,
  normalizeCandles,
  validateCandleRequest,
} from "@/lib/candles/utils";
import {
  calculateMarketStructure,
  getDefaultMarketStructureSettings,
  getReplayVisibleMarkers,
  getReplayVisibleZones,
} from "@/lib/market-structure/engine";
import type {
  MarkerSensitivity,
  MarkerVisibility,
  MarketMarker,
  MarketStructureSettings,
  ReplayState,
} from "@/lib/market-structure/types";
import { calculateMarketContext } from "@/lib/market-context/engine";
import type { ContextOverlayVisibility } from "@/lib/market-context/types";
import { scanSetups } from "@/lib/setup-scanner/engine";
import { generateHistoricalSignals } from "@/lib/entry-engine/engine";
import type { EntryMode, TradeSignal } from "@/lib/entry-engine/types";
import { runBacktest } from "@/lib/backtesting/engine";
import type { BacktestTrade } from "@/lib/backtesting/types";
import { buildSignalFunnel } from "@/lib/signal-funnel/engine";

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h"];
const SENSITIVITIES: MarkerSensitivity[] = ["low", "normal", "high"];
const REPLAY_SPEEDS: ReplayState["speed"][] = [1, 2, 5, 10];
const ENTRY_MODES: EntryMode[] = ["CALIBRATION", "EASY_SCALP", "NORMAL_SCALP", "PRO_TRADER"];
const DISPLAY_TIMEZONES = [
  "UTC",
  "Asia/Kolkata",
  "Europe/London",
  "America/New_York",
  "Asia/Tokyo",
];
const DEFAULT_VISIBILITY: MarkerVisibility = {
  swings: true,
  liquidity: true,
  sweeps: true,
  momentum: true,
  pressure: true,
  structure: true,
  fvg: false,
};
const DEFAULT_CONTEXT_OVERLAYS: ContextOverlayVisibility = {
  dealingRange: true,
  premiumDiscount: false,
  nearestLevels: true,
  sessionLevels: false,
  contextLabels: true,
};

export function MarketChartApp() {
  const [form, setForm] = useState<CandleFetchRequest>({
    symbol: "XAUUSD",
    timeframe: "5m",
    startDate: "2026-05-20T00:00",
    endDate: "2026-05-29T00:00",
  });
  const [rawCandles, setRawCandles] = useState<unknown[]>([]);
  const [normalizedCandles, setNormalizedCandles] = useState<Candle[]>([]);
  const [auditInfo, setAuditInfo] = useState<CandleAuditInfo | null>(null);
  const [visibleRange, setVisibleRange] = useState("No visible range");
  const [markerSettings, setMarkerSettings] = useState<MarketStructureSettings>(
    getDefaultMarketStructureSettings,
  );
  const [markerVisibility, setMarkerVisibility] =
    useState<MarkerVisibility>(DEFAULT_VISIBILITY);
  const [showTooltips, setShowTooltips] = useState(true);
  const hydrationTimezone = useSyncExternalStore(
    subscribeToHydration,
    getInitialTimezone,
    () => "UTC",
  );
  const hasHydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const [selectedDisplayTimezone, setSelectedDisplayTimezone] = useState<string | null>(null);
  const displayTimezone = selectedDisplayTimezone ?? hydrationTimezone;
  const [contextOverlays, setContextOverlays] = useState<ContextOverlayVisibility>(DEFAULT_CONTEXT_OVERLAYS);
  const [showSetupOverlays, setShowSetupOverlays] = useState(true);
  const [entryMode, setEntryMode] = useState<EntryMode>("CALIBRATION");
  const [maxRiskAmount, setMaxRiskAmount] = useState(100);
  const [showSignalOverlays, setShowSignalOverlays] = useState(true);
  const [selectedSignal, setSelectedSignal] = useState<TradeSignal | null>(null);
  const [selectedBacktestTrade, setSelectedBacktestTrade] = useState<BacktestTrade | null>(null);
  const [selectedMarker, setSelectedMarker] = useState<MarketMarker | null>(null);
  const [replay, setReplay] = useState<ReplayState>({
    enabled: false,
    playing: false,
    speed: 1,
    index: 0,
  });
  const [liveMode, setLiveMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const chartCandles = useMemo(
    () =>
      filterCandlesByDateRange(
        normalizedCandles,
        form.startDate,
        form.endDate,
      ),
    [normalizedCandles, form.startDate, form.endDate],
  );
  const marketStructure = useMemo(
    () =>
      calculateMarketStructure({
        candles: chartCandles,
        symbol: form.symbol,
        timeframe: form.timeframe,
        startDate: form.startDate,
        endDate: form.endDate,
        settings: markerSettings,
      }),
    [
      chartCandles,
      form.symbol,
      form.timeframe,
      form.startDate,
      form.endDate,
      markerSettings,
    ],
  );
  const replayIndex = replay.enabled
    ? Math.min(replay.index, Math.max(0, chartCandles.length - 1))
    : Math.max(0, chartCandles.length - 1);
  const displayCandles = useMemo(
    () =>
      replay.enabled ? chartCandles.slice(0, replayIndex + 1) : chartCandles,
    [chartCandles, replay.enabled, replayIndex],
  );
  const displayMarkers = useMemo(() => {
    const replayFiltered = replay.enabled
      ? getReplayVisibleMarkers(marketStructure.markers, replayIndex)
      : marketStructure.markers;

    return replayFiltered.filter((marker) =>
      isMarkerVisible(marker, markerVisibility),
    );
  }, [marketStructure.markers, markerVisibility, replay.enabled, replayIndex]);
  const displayLiquidityZones = useMemo(() => {
    if (!markerVisibility.liquidity) {
      return [];
    }

    return replay.enabled
      ? getReplayVisibleZones(marketStructure.liquidityZones, replayIndex)
      : marketStructure.liquidityZones;
  }, [
    marketStructure.liquidityZones,
    markerVisibility.liquidity,
    replay.enabled,
    replayIndex,
  ]);
  const currentReplayCandle = replay.enabled ? chartCandles[replayIndex] : null;
  const candleReading = useMemo(
    () =>
      analyzeCandleReading(displayCandles, {
        windowSize: 20,
        atrPeriod: markerSettings.atrPeriod,
      }),
    [displayCandles, markerSettings.atrPeriod],
  );
  const marketContext = useMemo(
    () => calculateMarketContext({
      candles: displayCandles,
      symbol: form.symbol,
      timeframe: form.timeframe,
      startDate: form.startDate,
      endDate: form.endDate,
      marketStructureSettings: markerSettings,
      displayTimezone,
    }),
    [displayCandles, form.symbol, form.timeframe, form.startDate, form.endDate, markerSettings, displayTimezone],
  );
  const scannerStructure = useMemo(
    () => calculateMarketStructure({
      candles: displayCandles,
      symbol: `${form.symbol}-scanner`,
      timeframe: form.timeframe,
      startDate: form.startDate,
      endDate: form.endDate,
      settings: markerSettings,
    }),
    [displayCandles, form.symbol, form.timeframe, form.startDate, form.endDate, markerSettings],
  );
  const setupScanner = useMemo(
    () => scanSetups({
      candles: displayCandles,
      symbol: form.symbol,
      timeframe: form.timeframe,
      startDate: form.startDate,
      endDate: form.endDate,
      structure: scannerStructure,
      context: marketContext,
      candleReading,
    }),
    [candleReading, displayCandles, form.symbol, form.timeframe, form.startDate, form.endDate, marketContext, scannerStructure],
  );
  const historicalSetupScanner = useMemo(
    () => scanSetups({
      candles: displayCandles,
      symbol: `${form.symbol}-historical-signals`,
      timeframe: form.timeframe,
      startDate: form.startDate,
      endDate: form.endDate,
      structure: scannerStructure,
      context: marketContext,
      candleReading,
      settings: {
        maxActiveSetups: 5_000,
        maxSetupAgeBars: 100_000,
        maxWatchAgeBars: 100_000,
      },
    }),
    [candleReading, displayCandles, form.symbol, form.timeframe, form.startDate, form.endDate, marketContext, scannerStructure],
  );
  const entrySignals = useMemo(
    () => generateHistoricalSignals({
      candles: displayCandles,
      symbol: form.symbol,
      timeframe: form.timeframe,
      startDate: form.startDate,
      endDate: form.endDate,
      mode: entryMode,
      setupScanner: historicalSetupScanner,
      context: marketContext,
      structure: scannerStructure,
      candleReading,
      settings: { maxRiskAmount },
    }),
    [candleReading, displayCandles, entryMode, form.endDate, form.startDate, form.symbol, form.timeframe, historicalSetupScanner, marketContext, maxRiskAmount, scannerStructure],
  );
  const activeSelectedSignal = selectedSignal && entrySignals.signalMap.has(selectedSignal.id)
    ? selectedSignal
    : null;
  const backtestResult = useMemo(
    () => runBacktest({
      candles: displayCandles,
      signals: entrySignals.signals,
      rejectedSetups: entrySignals.rejectedSetups,
      symbol: form.symbol.trim().toUpperCase(),
      timeframe: form.timeframe,
      startDate: form.startDate,
      endDate: form.endDate,
      settings: { signalMode: entryMode },
      marketRegime: marketContext.regime.regime,
    }),
    [displayCandles, entryMode, entrySignals.rejectedSetups, entrySignals.signals, form.endDate, form.startDate, form.symbol, form.timeframe, marketContext.regime.regime],
  );
  const activeSelectedBacktestTrade = selectedBacktestTrade && backtestResult.tradeMap.has(selectedBacktestTrade.tradeId)
    ? selectedBacktestTrade
    : null;
  const signalFunnel = useMemo(
    () => buildSignalFunnel({
      candles: displayCandles,
      rawCandlesCount: rawCandles.length,
      structure: scannerStructure,
      context: marketContext,
      setups: historicalSetupScanner,
      signals: entrySignals,
      backtest: backtestResult,
      mode: entryMode,
    }),
    [backtestResult, displayCandles, entryMode, entrySignals, historicalSetupScanner, marketContext, rawCandles.length, scannerStructure],
  );

  const handleVisibleRangeChange = useCallback((value: string) => {
    setVisibleRange(value);
  }, []);
  const handleMarkerHover = useCallback((marker: MarketMarker | null) => {
    setSelectedMarker(marker);
  }, []);
  const handleSignalHover = useCallback((signal: TradeSignal | null) => {
    if (signal) setSelectedSignal(signal);
  }, []);
  const handleSignalSelect = useCallback((signal: TradeSignal) => {
    setSelectedSignal(signal);
  }, []);

  const handleFetch = useCallback(async () => {
    const validationError = validateCandleRequest(form);

    if (validationError) {
      setError(validationError);
      return;
    }

    abortRef.current?.abort();

    const abortController = new AbortController();
    abortRef.current = abortController;

    setLoading(true);
    setError(null);
    setHasFetched(true);
    setRawCandles([]);
    setNormalizedCandles([]);
    setAuditInfo(null);
    setSelectedSignal(null);
    setSelectedBacktestTrade(null);

    try {
      const response = await fetchCandles(
        {
          ...form,
          symbol: form.symbol.trim().toUpperCase(),
        },
        abortController.signal,
      );

      await yieldToBrowser();

      const normalization = normalizeCandles(response.rawCandles, {
        timeframe: form.timeframe,
      });
      const gaps = detectCandleGaps(normalization.candles, form.timeframe);
      const priceRange = calculateMinMaxPrice(normalization.candles);

      setRawCandles(response.rawCandles);
      setNormalizedCandles(normalization.candles);
      setReplay((current) => ({
        ...current,
        playing: false,
        index: 0,
      }));
      setAuditInfo(
        buildAuditInfo({
          request: {
            ...form,
            symbol: form.symbol.trim().toUpperCase(),
          },
          normalization,
          gaps,
          priceRange,
          fetchDurationMs: response.fetchDurationMs,
          cacheStatus: response.cache.status,
        }),
      );
      setVisibleRange("No visible range");
    } catch (fetchError) {
      if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
        return;
      }

      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Unable to fetch candles.",
      );
    } finally {
      if (abortRef.current === abortController) {
        setLoading(false);
      }
    }
  }, [form]);

  useEffect(() => {
    if (!replay.enabled || !replay.playing) {
      return;
    }

    const timer = window.setInterval(() => {
      setReplay((current) => {
        const maxIndex = Math.max(0, chartCandles.length - 1);

        if (current.index >= maxIndex) {
          return {
            ...current,
            playing: false,
            index: maxIndex,
          };
        }

        return {
          ...current,
          index: Math.min(maxIndex, current.index + 1),
        };
      });
    }, Math.max(80, 700 / replay.speed));

    return () => window.clearInterval(timer);
  }, [chartCandles.length, replay.enabled, replay.playing, replay.speed]);

  useEffect(() => {
    if (!liveMode) {
      return;
    }

    const timer = window.setInterval(() => {
      void handleFetch();
    }, Math.max(15_000, getTimeframeMs(form.timeframe)));

    return () => window.clearInterval(timer);
  }, [form.timeframe, handleFetch, liveMode]);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <div className="mx-auto flex w-full max-w-screen-2xl flex-col gap-5 px-3 py-4 sm:px-5 lg:px-6 xl:px-8">
        <header className="flex flex-col gap-1 border-b border-slate-200 pb-4">
          <h1 className="text-xl font-semibold tracking-normal">
            XAUUSD Market Chart
          </h1>
          <p className="text-sm text-slate-600">
            Phase 7 backtesting and calibration
          </p>
        </header>

        <section className="border border-slate-200 bg-white p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_150px_190px_190px_auto] md:items-end">
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Symbol
              <input
                value={form.symbol}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    symbol: event.target.value,
                  }))
                }
                className="h-10 border border-slate-300 px-3 text-sm uppercase outline-none transition focus:border-slate-900"
                list="symbol-options"
              />
              <datalist id="symbol-options">
                <option value="XAUUSD" />
                <option value="EURUSD" />
                <option value="GBPUSD" />
                <option value="USDJPY" />
              </datalist>
            </label>

            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Timeframe
              <select
                value={form.timeframe}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    timeframe: event.target.value as Timeframe,
                  }))
                }
                className="h-10 border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-slate-900"
              >
                {TIMEFRAMES.map((timeframe) => (
                  <option key={timeframe} value={timeframe}>
                    {timeframe}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Start date
              <input
                type="datetime-local"
                value={form.startDate}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    startDate: event.target.value,
                  }))
                }
                className="h-10 border border-slate-300 px-3 text-sm outline-none transition focus:border-slate-900"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              End date
              <input
                type="datetime-local"
                value={form.endDate}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    endDate: event.target.value,
                  }))
                }
                className="h-10 border border-slate-300 px-3 text-sm outline-none transition focus:border-slate-900"
              />
            </label>

            <button
              type="button"
              onClick={handleFetch}
              disabled={loading}
              className="h-10 border border-slate-900 bg-slate-900 px-5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300"
            >
              {loading ? "Fetching" : "Fetch"}
            </button>
          </div>
          {/* <div className="mt-3 grid gap-3 sm:max-w-xs">
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Display timezone
              <select
                value={displayTimezone}
                onChange={(event) => setSelectedDisplayTimezone(event.target.value)}
                className="h-10 border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-slate-900"
              >
                {DISPLAY_TIMEZONES.map((timezone) => (
                  <option key={timezone} value={timezone}>
                    {timezone}
                  </option>
                ))}
              </select>
            </label>
          </div> */}
        </section>

        <section className="grid gap-4 border border-slate-200 bg-white p-4 lg:grid-cols-[1fr_1fr]">
          <MarkerControls
            settings={markerSettings}
            visibility={markerVisibility}
            showTooltips={showTooltips}
            liveMode={liveMode}
            onSettingsChange={setMarkerSettings}
            onVisibilityChange={setMarkerVisibility}
            onShowTooltipsChange={setShowTooltips}
            onLiveModeChange={setLiveMode}
          />
          <ReplayControls
            replay={replay}
            maxIndex={Math.max(0, chartCandles.length - 1)}
            currentTimestamp={currentReplayCandle?.time ?? null}
            onReplayChange={setReplay}
          />
          <ContextOverlayControls visibility={contextOverlays} onChange={setContextOverlays} />
          <EntryControls
            mode={entryMode}
            maxRiskAmount={maxRiskAmount}
            overlaysVisible={showSignalOverlays}
            onModeChange={setEntryMode}
            onMaxRiskAmountChange={setMaxRiskAmount}
            onOverlaysVisibleChange={setShowSignalOverlays}
          />
        </section>

        <MarketContextDashboard
          context={marketContext}
          cacheStatusLabel={hasHydrated ? marketContext.cacheStatus : "-"}
        />

        <SetupScannerPanel
          result={setupScanner}
          replayEnabled={replay.enabled}
          overlaysVisible={showSetupOverlays}
          onOverlaysVisibleChange={setShowSetupOverlays}
        />

        <SignalHistoryTable
          signals={entrySignals.signals}
          symbol={form.symbol.trim().toUpperCase()}
          timeframe={form.timeframe}
          selectedSignalId={activeSelectedSignal?.id ?? null}
          onSignalSelect={handleSignalSelect}
        />

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)]">
          <div className="w-full min-w-0 flex-1 overflow-hidden rounded border border-slate-200 bg-white">
            <CandlestickChart
              candles={displayCandles}
              markers={displayMarkers}
              liquidityZones={displayLiquidityZones}
              loading={loading}
              error={error}
              hasFetched={hasFetched}
              visibleRange={visibleRange}
              showTooltips={showTooltips}
              candleReading={candleReading}
              marketContext={marketContext}
              contextOverlays={contextOverlays}
              setups={setupScanner.setups}
              showSetupOverlays={showSetupOverlays}
              signals={entrySignals.signals}
              showSignalOverlays={showSignalOverlays}
              selectedSignalId={activeSelectedSignal?.id ?? null}
              backtestTrades={backtestResult.trades}
              selectedBacktestTradeId={activeSelectedBacktestTrade?.tradeId ?? null}
              onMarkerHover={handleMarkerHover}
              onSignalHover={handleSignalHover}
              onVisibleRangeChange={handleVisibleRangeChange}
            />
          </div>
        </div>
      </div>
    </main>
  );
}

function EntryControls({
  mode,
  maxRiskAmount,
  overlaysVisible,
  onModeChange,
  onMaxRiskAmountChange,
  onOverlaysVisibleChange,
}: {
  mode: EntryMode;
  maxRiskAmount: number;
  overlaysVisible: boolean;
  onModeChange: (mode: EntryMode) => void;
  onMaxRiskAmountChange: (value: number) => void;
  onOverlaysVisibleChange: (value: boolean) => void;
}) {
  return (
    <div className="border-t border-slate-200 pt-3 lg:col-span-2">
      <h2 className="text-sm font-semibold uppercase text-slate-700">Entry Engine</h2>
      <div className="mt-2 flex flex-wrap items-end gap-4">
        <label className="flex min-w-48 flex-col gap-1 text-sm font-medium text-slate-700">
          Signal mode
          <select
            value={mode}
            onChange={(event) => {
              const nextMode = event.target.value as EntryMode;
              onModeChange(nextMode);
            }}
            className="h-10 border border-slate-300 bg-white px-3 text-sm outline-none focus:border-slate-900"
          >
            {ENTRY_MODES.map((entryMode) => <option key={entryMode} value={entryMode}>{formatControlLabel(entryMode)}</option>)}
          </select>
        </label>
        <label className="flex w-40 flex-col gap-1 text-sm font-medium text-slate-700">
          Max risk amount
          <input
            type="number"
            min="1"
            step="10"
            value={maxRiskAmount}
            onChange={(event) => onMaxRiskAmountChange(Math.max(1, Number(event.target.value) || 1))}
            className="h-10 border border-slate-300 px-3 text-sm outline-none focus:border-slate-900"
          />
        </label>
        <label className="flex h-10 items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={overlaysVisible} onChange={(event) => onOverlaysVisibleChange(event.target.checked)} />
          Signal markers and levels
        </label>
      </div>
    </div>
  );
}

function ContextOverlayControls({ visibility, onChange }: { visibility: ContextOverlayVisibility; onChange: (value: ContextOverlayVisibility) => void }) {
  return (
    <div className="border-t border-slate-200 pt-3 lg:col-span-2">
      <h2 className="text-sm font-semibold uppercase text-slate-700">Context Overlays</h2>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
        {Object.entries(visibility).map(([key, value]) => (
          <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={value} onChange={(event) => onChange({ ...visibility, [key]: event.target.checked })} />
            {formatControlLabel(key)}
          </label>
        ))}
      </div>
    </div>
  );
}

function MarkerControls({
  settings,
  visibility,
  showTooltips,
  liveMode,
  onSettingsChange,
  onVisibilityChange,
  onShowTooltipsChange,
  onLiveModeChange,
}: {
  settings: MarketStructureSettings;
  visibility: MarkerVisibility;
  showTooltips: boolean;
  liveMode: boolean;
  onSettingsChange: (settings: MarketStructureSettings) => void;
  onVisibilityChange: (visibility: MarkerVisibility) => void;
  onShowTooltipsChange: (value: boolean) => void;
  onLiveModeChange: (value: boolean) => void;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-normal text-slate-700">
        Marker Controls
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Sensitivity
          <select
            value={settings.sensitivity}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                sensitivity: event.target.value as MarkerSensitivity,
              })
            }
            className="h-9 border border-slate-300 bg-white px-2"
          >
            {SENSITIVITIES.map((sensitivity) => (
              <option key={sensitivity} value={sensitivity}>
                {sensitivity}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          Swing window
          <input
            type="number"
            min={1}
            max={10}
            value={settings.leftBars}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                leftBars: Number(event.target.value),
                rightBars: Number(event.target.value),
              })
            }
            className="h-9 border border-slate-300 px-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-700">
          ATR period
          <input
            type="number"
            min={2}
            max={100}
            value={settings.atrPeriod}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                atrPeriod: Number(event.target.value),
              })
            }
            className="h-9 border border-slate-300 px-2"
          />
        </label>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {Object.entries(visibility).map(([key, value]) => (
          <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={value}
              onChange={(event) =>
                onVisibilityChange({
                  ...visibility,
                  [key]: event.target.checked,
                })
              }
            />
            {formatControlLabel(key)}
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={settings.showOnlyMajor}
            onChange={(event) =>
              onSettingsChange({
                ...settings,
                showOnlyMajor: event.target.checked,
              })
            }
          />
          Major only
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={showTooltips}
            onChange={(event) => onShowTooltipsChange(event.target.checked)}
          />
          Tooltips
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={liveMode}
            onChange={(event) => onLiveModeChange(event.target.checked)}
          />
          Live refresh
        </label>
      </div>
    </div>
  );
}

function ReplayControls({
  replay,
  maxIndex,
  currentTimestamp,
  onReplayChange,
}: {
  replay: ReplayState;
  maxIndex: number;
  currentTimestamp: string | null;
  onReplayChange: (replay: ReplayState | ((current: ReplayState) => ReplayState)) => void;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold uppercase tracking-normal text-slate-700">
        Replay
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            onReplayChange((current) => ({
              ...current,
              enabled: true,
              playing: true,
            }))
          }
          className="h-9 border border-slate-900 bg-slate-900 px-3 text-sm text-white"
        >
          Play
        </button>
        <button
          type="button"
          onClick={() =>
            onReplayChange((current) => ({ ...current, playing: false }))
          }
          className="h-9 border border-slate-300 px-3 text-sm"
        >
          Pause
        </button>
        <button
          type="button"
          onClick={() =>
            onReplayChange((current) => ({
              ...current,
              enabled: true,
              playing: false,
              index: Math.max(0, current.index - 1),
            }))
          }
          className="h-9 border border-slate-300 px-3 text-sm"
        >
          Step back
        </button>
        <button
          type="button"
          onClick={() =>
            onReplayChange((current) => ({
              ...current,
              enabled: true,
              playing: false,
              index: Math.min(maxIndex, current.index + 1),
            }))
          }
          className="h-9 border border-slate-300 px-3 text-sm"
        >
          Step forward
        </button>
        <button
          type="button"
          onClick={() =>
            onReplayChange((current) => ({
              ...current,
              enabled: true,
              playing: false,
              index: 0,
            }))
          }
          className="h-9 border border-slate-300 px-3 text-sm"
        >
          Reset
        </button>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          Speed
          <select
            value={replay.speed}
            onChange={(event) =>
              onReplayChange((current) => ({
                ...current,
                speed: Number(event.target.value) as ReplayState["speed"],
              }))
            }
            className="h-9 border border-slate-300 bg-white px-2"
          >
            {REPLAY_SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {speed}x
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={replay.enabled}
            onChange={(event) =>
              onReplayChange((current) => ({
                ...current,
                enabled: event.target.checked,
                playing: event.target.checked ? current.playing : false,
              }))
            }
          />
          Replay mode
        </label>
      </div>
      <p className="mt-3 text-sm text-slate-600">
        Candle {replay.enabled ? replay.index : maxIndex} / {maxIndex}
        {currentTimestamp ? ` | ${currentTimestamp}` : ""}
      </p>
    </div>
  );
}

function MarkerTooltipPanel({ marker }: { marker: MarketMarker | null }) {
  return (
    <aside className="border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-normal text-slate-700">
          Marker Detail
        </h2>
      </div>
      {marker ? (
        <dl className="divide-y divide-slate-100">
          {getMarkerDetailRows(marker).map(([label, value]) => (
            <div key={label} className="grid gap-1 px-4 py-3 text-sm">
              <dt className="text-slate-500">{label}</dt>
              <dd className="font-medium text-slate-900">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="px-4 py-4 text-sm text-slate-500">
          Hover a marker to inspect its confirmation, source candles, and reason.
        </p>
      )}
    </aside>
  );
}

function getMarkerDetailRows(
  marker: MarketMarker,
): Array<[string, string | number]> {
  const rows: Array<[string, string | number]> = [
    ["Type", marker.type],
    ["Direction", marker.direction],
    ["Price", formatAuditNumber(marker.price)],
    ["Time", new Date(marker.timestamp).toISOString()],
    ["Strength", marker.strength],
    ["Confirmed at", new Date(marker.confirmedAtTimestamp).toISOString()],
    ["Source indexes", marker.sourceIndexes.join(", ")],
  ];

  if (marker.type === "MOMENTUM" || marker.type === "DISPLACEMENT") {
    rows.push(["Close position", formatAuditNumber(marker.closePosition)]);
    rows.push(["Body size", formatAuditNumber(marker.bodySize)]);
    rows.push(["ATR", formatAuditNumber(marker.atr)]);
  }

  if (marker.type === "BUYERS" || marker.type === "SELLERS") {
    rows.push(["Related momentum", marker.relatedMomentumId]);
    rows.push(["Related sweep", marker.relatedSweepId ?? "-"]);
  }

  if (marker.type === "SSL_SWEEP" || marker.type === "BSL_SWEEP") {
    rows.push(["Sweep kind", marker.sweepKind]);
    rows.push(["Swept liquidity", marker.sweptLiquidityId]);
    rows.push(["ATR distance", formatAuditNumber(marker.atrDistance)]);
  }

  if (marker.type === "FVG") {
    rows.push(["Middle index", marker.middleIndex]);
    rows.push(["Mitigated", marker.mitigated ? "yes" : "no"]);
  }

  rows.push(["Reason", marker.reason]);
  return rows;
}

function PhaseTwoAuditPanel({
  audit,
}: {
  audit: ReturnType<typeof calculateMarketStructure>["audit"];
}) {
  const hasMounted = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );

  const rows: Array<[string, string | number]> = [
    ["Total candles", audit.totalCandles],
    ["Swing highs", audit.totalSwingHighs],
    ["Swing lows", audit.totalSwingLows],
    ["BSL zones", audit.totalBslZones],
    ["SSL zones", audit.totalSslZones],
    ["Equal high zones", audit.totalEqualHighZones],
    ["Equal low zones", audit.totalEqualLowZones],
    ["Sweeps", audit.totalSweeps],
    ["SSL sweeps", audit.totalSslSweeps],
    ["BSL sweeps", audit.totalBslSweeps],
    ["Momentum candles", audit.totalMomentumCandles],
    ["Bullish momentum", audit.totalBullishMomentum],
    ["Bearish momentum", audit.totalBearishMomentum],
    ["BUYERS markers", audit.totalBuyersMarkers],
    ["SELLERS markers", audit.totalSellersMarkers],
    ["BOS", audit.totalBos],
    ["CHOCH", audit.totalChoch],
    ["MSS", audit.totalMss],
    ["FVG", audit.totalFvg],
    ["Mitigated FVG", audit.totalMitigatedFvg],
    ["Calculation ms", hasMounted ? audit.calculationTimeMs : "-"],
    ["Last marker", audit.lastMarkerCreated ?? "-"],
    ["Structure", audit.currentStructureState],
    ["Sensitivity", audit.markerSensitivitySettings.sensitivity],
    ["Marker cache", hasMounted ? audit.cacheStatus : "-"],
    ["No repaint", audit.noRepaintValidationStatus],
    ["Validation warnings", audit.validationWarnings.length],
  ];

  return (
    <div className="flex flex-col gap-3">
      <AuditRows title="Phase 2 Debug" rows={rows} />
      <aside className="border border-slate-200 bg-white p-4 text-xs leading-5 text-slate-600">
        <p>Liquidity = possible stop or pending-order area.</p>
        <p>Sweep = liquidity taken and rejected; not an entry.</p>
        <p>Momentum = directional candle strength versus ATR.</p>
        <p>BUYERS/SELLERS = pressure only, never trade signals.</p>
        <p>Structure = BOS, CHOCH, or MSS by candle close.</p>
        <p>FVG = displacement imbalance, not an entry by itself.</p>
      </aside>
    </div>
  );
}

function DataAuditPanel({
  auditInfo,
  rawCandlesCount,
  chartCandlesCount,
}: {
  auditInfo: CandleAuditInfo | null;
  rawCandlesCount: number;
  chartCandlesCount: number;
}) {
  const rows = auditInfo
    ? ([
        ["Selected symbol", auditInfo.symbol],
        ["Selected timeframe", auditInfo.timeframe],
        ["Start date", auditInfo.startDate],
        ["End date", auditInfo.endDate],
        ["Total fetched", auditInfo.totalCandlesFetched],
        ["Valid candles", auditInfo.validCandlesCount],
        ["Duplicates removed", auditInfo.removedDuplicateCount],
        ["Invalid candles", auditInfo.invalidCandleCount],
        ["First candle", auditInfo.firstCandleTime ?? "-"],
        ["Last candle", auditInfo.lastCandleTime ?? "-"],
        ["Gaps", auditInfo.missingCandleGapsCount],
        ["Fetch ms", auditInfo.fetchDurationMs],
        ["Cache", auditInfo.cacheStatus],
        ["Chart candles", chartCandlesCount],
      ] satisfies Array<[string, string | number]>)
    : ([
        ["Raw API data", rawCandlesCount],
        ["Chart candles", chartCandlesCount],
      ] satisfies Array<[string, string | number]>);

  return <AuditRows title="Data Audit" rows={rows} />;
}

function AuditRows({
  title,
  rows,
}: {
  title: string;
  rows: Array<[string, string | number]>;
}) {
  return (
    <aside className="border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-normal text-slate-700">
          {title}
        </h2>
      </div>
      <dl className="divide-y divide-slate-100">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3 text-sm"
          >
            <dt className="text-slate-500">{label}</dt>
            <dd className="max-w-[190px] overflow-hidden text-ellipsis text-right font-medium text-slate-900">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function isMarkerVisible(
  marker: MarketMarker,
  visibility: MarkerVisibility,
): boolean {
  if (marker.type === "SWING_HIGH" || marker.type === "SWING_LOW") {
    return visibility.swings;
  }

  if (marker.type === "SSL_SWEEP" || marker.type === "BSL_SWEEP") {
    return visibility.sweeps;
  }

  if (marker.type === "MOMENTUM" || marker.type === "DISPLACEMENT") {
    return visibility.momentum;
  }

  if (marker.type === "BUYERS" || marker.type === "SELLERS") {
    return visibility.pressure;
  }

  if (marker.type === "BOS" || marker.type === "CHOCH" || marker.type === "MSS") {
    return visibility.structure;
  }

  if (marker.type === "FVG") {
    return visibility.fvg;
  }

  return true;
}

function formatControlLabel(value: string): string {
  const explicit: Record<string, string> = {
    pressure: "BUYERS/SELLERS",
    structure: "BOS/CHOCH/MSS",
    fvg: "FVG",
    dealingRange: "Dealing range",
    premiumDiscount: "Premium / discount",
    nearestLevels: "Nearest levels",
    sessionLevels: "Session levels",
    contextLabels: "Context labels",
  };

  if (explicit[value]) {
    return explicit[value];
  }

  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatAuditNumber(value: number | null): string {
  if (value === null) {
    return "-";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 5,
  }).format(value);
}

function getInitialTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return DISPLAY_TIMEZONES.includes(timezone) ? timezone : "UTC";
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function subscribeToHydration(): () => void {
  return () => undefined;
}
