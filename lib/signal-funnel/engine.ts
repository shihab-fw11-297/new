import type { Candle } from "../candles/types";
import type { EntryEngineResult, EntryMode, RejectedSetup, SignalRejectionCode, TradeSignal } from "../entry-engine/types";
import type { MarketContextResult } from "../market-context/types";
import type { MarketStructureResult } from "../market-structure/types";
import type { SetupScannerResult } from "../setup-scanner/types";
import type { BacktestResult } from "../backtesting/types";
import type {
  GoldUnitDiagnostics,
  RejectionHistogramRow,
  SignalFunnelCounts,
  SignalFunnelResult,
  TriggerDiagnosticsRow,
} from "./types";

export function buildSignalFunnel(input: {
  candles: Candle[];
  rawCandlesCount: number;
  structure: MarketStructureResult;
  context: MarketContextResult;
  setups: SetupScannerResult;
  signals: EntryEngineResult;
  backtest: BacktestResult;
  mode: EntryMode;
}): SignalFunnelResult {
  const candles = input.candles.filter((candle) => candle.isClosed);
  const markers = input.structure.markers;
  const counts: SignalFunnelCounts = {
    totalCandles: input.rawCandlesCount || input.candles.length,
    validClosedCandles: candles.length,
    ltfCandles: candles.length,
    itfCandles: input.context.itfCandles.length,
    htfCandles: input.context.htfCandles.length,
    swingHighCount: markers.filter((marker) => marker.type === "SWING_HIGH").length,
    swingLowCount: markers.filter((marker) => marker.type === "SWING_LOW").length,
    bslCount: input.structure.liquidityZones.filter((zone) => zone.type === "BSL").length,
    sslCount: input.structure.liquidityZones.filter((zone) => zone.type === "SSL").length,
    sweepCount: markers.filter((marker) => marker.type === "SSL_SWEEP" || marker.type === "BSL_SWEEP").length,
    displacementCount: markers.filter((marker) => marker.type === "DISPLACEMENT").length,
    buyersCount: markers.filter((marker) => marker.type === "BUYERS").length,
    sellersCount: markers.filter((marker) => marker.type === "SELLERS").length,
    bosCount: markers.filter((marker) => marker.type === "BOS").length,
    chochCount: markers.filter((marker) => marker.type === "CHOCH").length,
    mssCount: markers.filter((marker) => marker.type === "MSS").length,
    fvgCount: markers.filter((marker) => marker.type === "FVG").length,
    contextCount: candles.length > 0 ? 1 : 0,
    bullishContextCount: input.context.htfBias.bias === "BULLISH" ? 1 : 0,
    bearishContextCount: input.context.htfBias.bias === "BEARISH" ? 1 : 0,
    neutralContextCount: ["NEUTRAL", "RANGING", "UNKNOWN"].includes(input.context.htfBias.bias) ? 1 : 0,
    waitContextCount: input.context.wait.shouldWait || input.context.regime.regime === "WAIT" ? 1 : 0,
    watchSetupCount: input.setups.audit.watchCount,
    setupCount: input.setups.audit.setupCount,
    triggerSetupCount: input.setups.audit.triggerCount,
    invalidatedSetupCount: input.setups.audit.invalidatedCount,
    expiredSetupCount: input.setups.audit.expiredCount,
    pendingConfirmationCount: input.signals.audit.pendingConfirmationCount,
    expiredConfirmationCount: input.signals.audit.expiredConfirmationCount,
    invalidatedCandidateCount: input.signals.audit.invalidatedCandidateCount,
    confirmedBuyCount: input.signals.audit.confirmedBuyCount,
    confirmedSellCount: input.signals.audit.confirmedSellCount,
    rejectedSignalCount: input.signals.audit.rejectedSetupCount,
    backtestTradeCount: input.backtest.trades.length,
  };

  return {
    counts,
    zeroCountExplanations: explainZeroCounts(counts),
    topRejectionReasons: buildHistogram(input.signals.rejectedSetups, candles),
    scan: {
      firstScannedCandleTime: candles[0]?.time ?? null,
      lastScannedCandleTime: candles.at(-1)?.time ?? null,
      scannedCandleCount: candles.length,
      scanMode: "FULL_HISTORY",
    },
    triggerDiagnostics: buildTriggerDiagnostics(input.setups, input.signals, candles, input.mode),
    goldUnits: buildGoldUnitDiagnostics(candles, input.structure.atr, input.signals.signals),
    blocker: identifyBlocker(counts),
  };
}

function explainZeroCounts(counts: SignalFunnelCounts): string[] {
  const explanations: string[] = [];
  if (counts.validClosedCandles === 0) explanations.push("No valid closed candles. Phase 1 data fetch or normalization is blocking.");
  if (counts.htfCandles === 0) explanations.push("HTF candles are missing. Phase 3 context may stay WAIT until enough history exists.");
  if (counts.itfCandles === 0) explanations.push("ITF candles are missing. Phase 3 setup context may be incomplete.");
  if (counts.swingHighCount === 0 || counts.swingLowCount === 0) explanations.push("Swing markers are missing. Phase 2 swing detection may need more candles or lower sensitivity.");
  if (counts.bslCount === 0 || counts.sslCount === 0) explanations.push("Liquidity zones are missing. SSL/BSL logic may be too strict or not enough swing touches exist.");
  if (counts.sweepCount === 0) explanations.push("No sweeps detected. Liquidity sweep logic is the likely blocker.");
  if (counts.displacementCount === 0) explanations.push("No displacement candles detected. Momentum threshold may be too strict.");
  if (counts.triggerSetupCount === 0) explanations.push("No TRIGGER setups. Phase 4 setup scanner is blocking before Phase 5 can create signals.");
  if (counts.triggerSetupCount > 0 && counts.confirmedBuyCount + counts.confirmedSellCount === 0) explanations.push("TRIGGER setups exist, but no confirmed signals. Phase 5 confirmation, SL/TP, RR, or context filters are blocking.");
  if (counts.confirmedBuyCount + counts.confirmedSellCount > 0 && counts.backtestTradeCount === 0) explanations.push("Confirmed signals exist, but backtest has no trades. Phase 6/7 conversion or risk filters are blocking.");
  return explanations;
}

function buildHistogram(rejectedSetups: RejectedSetup[], candles: Candle[]): RejectionHistogramRow[] {
  const rows = new Map<SignalRejectionCode, { count: number; setup: RejectedSetup; reason: string }>();
  for (const setup of rejectedSetups) {
    const codes = setup.rejectionReasonCodes.length ? setup.rejectionReasonCodes : setup.rejectionReasons.map(inferCode);
    for (const code of codes) {
      const existing = rows.get(code);
      rows.set(code, {
        count: (existing?.count ?? 0) + 1,
        setup: existing?.setup ?? setup,
        reason: existing?.reason ?? reasonForCode(setup, code),
      });
    }
  }
  const total = [...rows.values()].reduce((sum, item) => sum + item.count, 0);
  return [...rows.entries()]
    .map(([reason, item]) => ({
      reason,
      count: item.count,
      percentage: total ? round(item.count / total * 100, 2) : 0,
      exampleTime: item.setup.triggerIndex === null ? null : candles[item.setup.triggerIndex]?.time ?? null,
      exampleDetails: `${item.setup.setupId}: ${item.reason}`,
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 10);
}

function reasonForCode(setup: RejectedSetup, code: SignalRejectionCode): string {
  return setup.rejectionReasons.find((reason) => inferCode(reason) === code) ?? setup.rejectionReasons[0] ?? code;
}

function buildTriggerDiagnostics(setups: SetupScannerResult, signals: EntryEngineResult, candles: Candle[], mode: EntryMode): TriggerDiagnosticsRow[] {
  const signalsBySetup = new Map(signals.signals.map((signal) => [signal.sourceSetupId, signal]));
  const rejectionBySetup = new Map(signals.rejectedSetups.map((setup) => [setup.setupId, setup]));
  const debugBySetup = new Map(signals.candidateDebug.map((debug) => [debug.setupId, debug]));
  return setups.setups
    .filter((setup) => setup.state === "TRIGGER" || setup.history.some((item) => item.to === "TRIGGER"))
    .slice(-20)
    .map((setup) => {
      const signal = signalsBySetup.get(setup.id);
      const rejection = rejectionBySetup.get(setup.id);
      const debug = debugBySetup.get(setup.id);
      const triggerIndex = setup.history.findLast((item) => item.to === "TRIGGER")?.candleIndex ?? setup.updatedAtIndex;
      const entryCandidate = signal?.entryPrice ?? candles[triggerIndex]?.close ?? null;
      const stopLoss = signal?.stopLoss ?? null;
      const takeProfit = signal?.takeProfit ?? setup.targetLiquidity?.price ?? null;
      const rr = signal?.rr ?? null;
      return {
        setupId: setup.id,
        direction: setup.direction,
        setupType: setup.type,
        score: setup.score,
        requiredSetupScore: debug?.requiredSetupScore ?? 0,
        finalSignalScore: debug?.finalSignalScore ?? signal?.score ?? null,
        requiredSignalScore: debug?.requiredSignalScore ?? 0,
        confirmationStatus: debug?.confirmationStatus ?? (signal ? "CONFIRMED" : "REJECTED"),
        confirmationWindowRemaining: debug?.confirmationWindowRemaining ?? 0,
        entryCandidate,
        stopLoss,
        takeProfit,
        rr,
        mode,
        rejected: !signal,
        rejectionReason: debug?.rejectionReason ?? rejection?.rejectionReasons[0] ?? (signal ? "Accepted" : "No Phase 5 evaluation recorded"),
        nextRequiredAction: debug?.nextRequiredAction ?? (signal ? "Signal confirmed." : "Review Phase 5 filters."),
      };
    });
}

function buildGoldUnitDiagnostics(candles: Candle[], atrValues: number[], signals: TradeSignal[]): GoldUnitDiagnostics {
  const latestSignal = signals.at(-1);
  const referenceIndex = Math.min(
    Math.max(0, latestSignal?.confirmedAtIndex ?? candles.length - 1),
    Math.max(0, candles.length - 1),
  );
  const ranges = candles
    .slice(Math.max(0, referenceIndex - 19), referenceIndex + 1)
    .map((candle) => candle.high - candle.low);
  const atr = atrValues[referenceIndex] > 0 ? atrValues[referenceIndex] : mean(ranges);
  const stopDistance = latestSignal ? Math.abs(latestSignal.entryPrice - latestSignal.stopLoss) : null;
  const targetDistance = latestSignal ? Math.abs(latestSignal.takeProfit - latestSignal.entryPrice) : null;
  const calibrationMode = latestSignal?.mode === "CALIBRATION";
  return {
    currentPrice: candles.at(-1)?.close ?? null,
    signalEntryPrice: latestSignal?.entryPrice ?? null,
    atr: Number.isFinite(atr) ? round(atr) : null,
    averageCandleRange: ranges.length ? round(mean(ranges)) : null,
    stopDistance: stopDistance === null ? null : round(stopDistance),
    targetDistance: targetDistance === null ? null : round(targetDistance),
    rr: latestSignal?.rr ?? null,
    minAllowedStop: Number.isFinite(atr) ? round(atr * (calibrationMode ? 0.08 : 0.12)) : null,
    maxAllowedStop: Number.isFinite(atr) ? round(atr * (calibrationMode ? 8 : 5)) : null,
  };
}

function identifyBlocker(counts: SignalFunnelCounts): string {
  if (counts.validClosedCandles === 0) return "Phase 1 candle data is blocking.";
  if (counts.confirmedBuyCount + counts.confirmedSellCount > 0) {
    return counts.backtestTradeCount > 0
      ? "Pipeline is producing confirmed signals and backtest trades."
      : "Phase 7 trade conversion is blocking.";
  }
  if (counts.sweepCount === 0) return "Phase 2 sweep detection is blocking.";
  if (counts.displacementCount === 0) return "Phase 2 displacement detection is blocking.";
  if (counts.contextCount === 0 || counts.waitContextCount > 0) return "Phase 3 context is WAIT or incomplete.";
  if (counts.triggerSetupCount === 0) return "Phase 4 setup scanner is blocking.";
  return "Phase 5 confirmed entry rules are blocking.";
}

function inferCode(reason: string): SignalRejectionCode {
  const text = reason.toLowerCase();
  if (text.includes("waiting for confirmation")) return "CONFIRMATION_PENDING";
  if (text.includes("confirmation window expired") || text.includes("trigger expired")) return "CONFIRMATION_WINDOW_EXPIRED";
  if (text.includes("invalidated before confirmation")) return "INVALIDATED_BEFORE_CONFIRMATION";
  if (text.includes("future candle") || text.includes("future data")) return "DATA_NOT_ENOUGH";
  if (text.includes("trigger")) return "SETUP_NOT_TRIGGER";
  if (text.includes("rr")) return "RR_TOO_LOW";
  if (text.includes("stop")) return "STOP_LOSS_INVALID";
  if (text.includes("target")) return "TAKE_PROFIT_NOT_FOUND";
  if (text.includes("confirm")) return "CONFIRMATION_CANDLE_MISSING";
  if (text.includes("extended") || text.includes("chase")) return "PRICE_TOO_EXTENDED";
  if (text.includes("reversal")) return "REVERSAL_RISK_HIGH";
  if (text.includes("wait")) return "CONTEXT_WAIT";
  if (text.includes("htf")) return "HTF_OPPOSITE";
  if (text.includes("choppy")) return "MARKET_CHOPPY";
  if (text.includes("volatility")) return "VOLATILITY_BAD";
  return "DATA_NOT_ENOUGH";
}

function mean(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function round(value: number, digits = 5): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
