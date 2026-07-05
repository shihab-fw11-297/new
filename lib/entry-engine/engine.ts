import type { Candle } from "../candles/types";
import { analyzeCandleReading } from "../candle-reading/engine";
import type { CandleReadingResult } from "../candle-reading/types";
import { calculateMarketContext } from "../market-context/engine";
import type { KeyLevel, MarketContextResult } from "../market-context/types";
import type { MarketMarker } from "../market-structure/types";
import { calculateSetupScore } from "../setup-scanner/engine";
import type { MarketSetup } from "../setup-scanner/types";
import type {
  EntryEngineInput,
  EntryEngineResult,
  EntryEngineSettings,
  EntryMode,
  NoTradeResult,
  ConfirmationStatus,
  SignalRejectionCode,
  SignalCandidateDebug,
  SignalEvaluation,
  SignalScoreBreakdown,
  RejectedSetup,
  StopLossResult,
  TakeProfitResult,
  TradeSignal,
} from "./types";

const DEFAULT_SETTINGS: EntryEngineSettings = {
  maxRiskAmount: 100,
  atrBufferMultiplier: 0.12,
  confirmationWindowCandles: 3,
  maxConfirmationBars: 3,
  maxSignalAgeBars: 16,
};

// Mode configuration with practical thresholds and behaviors
export const MODE_CONFIG: Record<EntryMode, {
  label: string;
  description: string;
  requiredSetupScore: number;
  requiredSignalScore: number;
  minRR: number;
  extensionAtr: number;
  confirmationWindowCandles: number;
  allowNeutralHTF: boolean;
  rejectOppositeHTF: boolean;
  allowTriggerAsConfirmation: boolean;
  sessionFilterMode: "WARNING_ONLY" | "SOFT" | "MEDIUM" | "STRICT";
  volatilityFilterMode: "WARNING_ONLY" | "SOFT" | "MEDIUM" | "STRICT";
  reversalRiskMode: "WARNING_ONLY" | "SOFT" | "BLOCK_HIGH" | "BLOCK_MEDIUM_HIGH";
}> = {
  CALIBRATION: {
    label: "Calibration",
    description: "Debug mode for finding candidates and pipeline blockers. Not for live trading.",
    requiredSetupScore: 40,
    requiredSignalScore: 45,
    minRR: 1.0,
    extensionAtr: 3.5,
    confirmationWindowCandles: 4,
    allowNeutralHTF: true,
    rejectOppositeHTF: false,
    allowTriggerAsConfirmation: true,
    sessionFilterMode: "WARNING_ONLY",
    volatilityFilterMode: "WARNING_ONLY",
    reversalRiskMode: "WARNING_ONLY",
  },

  EASY_SCALP: {
    label: "Easy Scalp",
    description: "Discovery/testing mode with more signals but still requires valid SL/TP/RR.",
    requiredSetupScore: 50,
    requiredSignalScore: 55,
    minRR: 1.2,
    extensionAtr: 2,
    confirmationWindowCandles: 3,
    allowNeutralHTF: true,
    rejectOppositeHTF: false,
    allowTriggerAsConfirmation: true,
    sessionFilterMode: "SOFT",
    volatilityFilterMode: "SOFT",
    reversalRiskMode: "SOFT",
  },

  NORMAL_SCALP: {
    label: "Normal Scalp",
    description: "Practical trading mode with strong candle confirmation and 1.5R minimum.",
    requiredSetupScore: 55,
    requiredSignalScore: 60,
    minRR: 1.5,
    extensionAtr: 1.5,
    confirmationWindowCandles: 3,
    allowNeutralHTF: true,
    rejectOppositeHTF: true,
    allowTriggerAsConfirmation: true,
    sessionFilterMode: "MEDIUM",
    volatilityFilterMode: "MEDIUM",
    reversalRiskMode: "BLOCK_HIGH",
  },

  PRO_TRADER: {
    label: "Pro Trader",
    description: "Strict high-quality mode requiring strong HTF alignment, clean structure, and higher RR.",
    requiredSetupScore: 75,
    requiredSignalScore: 80,
    minRR: 2.0,
    extensionAtr: 1.25,
    confirmationWindowCandles: 2,
    allowNeutralHTF: false,
    rejectOppositeHTF: true,
    allowTriggerAsConfirmation: true,
    sessionFilterMode: "STRICT",
    volatilityFilterMode: "STRICT",
    reversalRiskMode: "BLOCK_MEDIUM_HIGH",
  },
};

// Backward compatibility reference
const MODE_RULES: Record<EntryMode, { setupScore: number; signalScore: number; rr: number; extensionAtr: number; confirmationWindowCandles?: number }> = {
  CALIBRATION: { setupScore: 40, signalScore: 45, rr: 1.0, extensionAtr: 3.5, confirmationWindowCandles: 4 },
  EASY_SCALP: { setupScore: 50, signalScore: 55, rr: 1.2, extensionAtr: 2, confirmationWindowCandles: 3 },
  NORMAL_SCALP: { setupScore: 55, signalScore: 60, rr: 1.5, extensionAtr: 1.5, confirmationWindowCandles: 3 },
  PRO_TRADER: { setupScore: 75, signalScore: 80, rr: 2.0, extensionAtr: 1.25, confirmationWindowCandles: 2 },
};

const resultCache = new Map<string, EntryEngineResult>();

type HistoricalSnapshot = {
  context: MarketContextResult;
  candleReading: CandleReadingResult;
};

type ConfirmationSearchResult = {
  status: Extract<ConfirmationStatus, "CONFIRMED" | "PENDING_CONFIRMATION" | "EXPIRED_CONFIRMATION" | "INVALIDATED">;
  index: number | null;
  windowRemaining: number;
  reason: string;
  nextRequiredAction: string;
};

export function getDefaultEntryEngineSettings(): EntryEngineSettings {
  return { ...DEFAULT_SETTINGS };
}

function normalizeSettings(settings?: Partial<EntryEngineSettings>): EntryEngineSettings {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const confirmationWindowCandles = settings?.confirmationWindowCandles ?? settings?.maxConfirmationBars ?? DEFAULT_SETTINGS.confirmationWindowCandles;
  return {
    ...merged,
    confirmationWindowCandles,
    maxConfirmationBars: confirmationWindowCandles,
  };
}

export function generateTradeSignals(input: EntryEngineInput): EntryEngineResult {
  const started = performance.now();
  const settings = normalizeSettings(input.settings);
  const rules = MODE_RULES[input.mode];
  const candles = input.candles.filter((candle) => candle.isClosed);
  const cacheKey = buildCacheKey(input, candles, settings);
  const cached = resultCache.get(cacheKey);
  if (cached) return cloneResult(cached, "hit");

  const triggerSetups = input.setupScanner.setups.filter(hasTriggerState);
  const snapshotResolver = createHistoricalSnapshotResolver(input, candles);
  const evaluations = triggerSetups.map((setup) =>
    evaluateSetup(input, candles, setup, settings, snapshotResolver),
  );
  const signals = evaluations.flatMap((evaluation) => evaluation.signal ? [evaluation.signal] : []);
  const pendingCandidates = evaluations
    .filter((evaluation) => evaluation.confirmationStatus === "PENDING_CONFIRMATION")
    .map((evaluation) => evaluation.debug);
  const candidateDebug = evaluations.map((evaluation) => evaluation.debug);
  const rejectedEvaluations = evaluations.filter((evaluation) => evaluation.confirmationStatus !== "PENDING_CONFIRMATION");
  const rejectedSetups = evaluations
    .filter((evaluation) => evaluation.signal === null && evaluation.confirmationStatus !== "PENDING_CONFIRMATION")
    .map(toRejectedSetup);
  const rejectionReasons = unique(rejectedEvaluations.flatMap((evaluation) => evaluation.rejectionReasons));
  const lastIndex = candles.length - 1;
  const updatedSignals = dedupeSignals(signals)
    .map((signal) => updateSignalStatus(signal, candles, settings.maxSignalAgeBars))
    .sort((a, b) => a.confirmedAtIndex - b.confirmedAtIndex);
  const signalMap = new Map(updatedSignals.map((signal) => [signal.id, signal]));
  const lastSignal = updatedSignals.at(-1) ?? null;
  const noSignalMessage = updatedSignals.length === 0 && pendingCandidates.length > 0
    ? `${pendingCandidates.length} signal candidate${pendingCandidates.length === 1 ? "" : "s"} waiting for confirmation. No BUY/SELL is created until a closed confirmation candle passes Phase 5.`
    : updatedSignals.length === 0
      ? `No confirmed signal because ${input.setupScanner.setups.length} setups were scanned, ${triggerSetups.length} reached TRIGGER, but all failed ${primaryFailureGroup(rejectionReasons)} rules.`
      : null;
  const noTrade = updatedSignals.length === 0
    ? buildNoTrade(
      input,
      triggerSetups,
      pendingCandidates.length ? pendingCandidates.map((candidate) => candidate.nextRequiredAction) : rejectionReasons,
      candles.at(-1)?.timestamp ?? null,
      noSignalMessage ?? "No confirmed signal was generated.",
      buildRequiredForSignal(input.mode),
    )
    : null;
  const noRepaintValidation = updatedSignals.every((signal) =>
    signal.confirmedAtIndex <= lastIndex && signal.noRepaintProof.passed,
  ) ? "PASS" : "WARNING";
  const stateCounts = countSetupStates(input.setupScanner.setups);
  const topRejectionReasons = countTopReasons(rejectedEvaluations.flatMap((evaluation) => evaluation.rejectionReasons), 10);
  const lastFiveTriggerSetups = triggerSetups.slice(-5).map((setup) => `${setup.id} @ ${triggerIndexFor(setup) ?? setup.updatedAtIndex}`);
  const lastFiveConfirmedSignals = updatedSignals.slice(-5).map((signal) => `${signal.type} ${new Date(signal.timestamp).toISOString()} ${signal.rr.toFixed(2)}R`);
  const noRepaintWarnings = updatedSignals
    .filter((signal) => !signal.noRepaintProof.passed)
    .map((signal) => `${signal.id}: ${signal.noRepaintProof.message}`);
  const calculationTimeMs = round(performance.now() - started, 2);
  const result: EntryEngineResult = {
    signals: updatedSignals,
    activeSignals: updatedSignals.filter((signal) => signal.status === "CONFIRMED" || signal.status === "ACTIVE"),
    signalMap,
    pendingCandidates,
    candidateDebug,
    rejectedSetups,
    noTrade,
    audit: {
      activeMode: input.mode,
      minimumScoreRequired: rules.signalScore,
      minimumSetupScoreRequired: rules.setupScore,
      minimumSignalScoreRequired: rules.signalScore,
      minimumRrRequired: rules.rr,
      totalCandlesScanned: candles.length,
      totalMarkersGenerated: input.structure.markers.length,
      totalContextsGenerated: 1,
      totalPhase4Setups: input.setupScanner.setups.length,
      watchCount: stateCounts.WATCH,
      setupCount: stateCounts.SETUP,
      invalidatedCount: stateCounts.INVALIDATED,
      expiredCount: stateCounts.EXPIRED,
      totalSetupsScanned: input.setupScanner.setups.length,
      triggerSetupsFound: triggerSetups.length,
      pendingConfirmationCount: pendingCandidates.length,
      expiredConfirmationCount: evaluations.filter((evaluation) => evaluation.confirmationStatus === "EXPIRED_CONFIRMATION").length,
      invalidatedCandidateCount: evaluations.filter((evaluation) => evaluation.confirmationStatus === "INVALIDATED").length,
      confirmedBuyCount: updatedSignals.filter((signal) => signal.type.endsWith("BUY")).length,
      confirmedSellCount: updatedSignals.filter((signal) => signal.type.endsWith("SELL")).length,
      rapidBuyCount: updatedSignals.filter((signal) => signal.type === "RAPID_BUY").length,
      rapidSellCount: updatedSignals.filter((signal) => signal.type === "RAPID_SELL").length,
      rapidSignalCount: updatedSignals.filter((signal) => signal.type.startsWith("RAPID")).length,
      rejectedSetupCount: rejectedSetups.length,
      lastRejectionReason: rejectionReasons.at(-1) ?? null,
      lastConfirmedSignal: lastSignal?.type ?? null,
      topRejectionReasons,
      lastFiveTriggerSetups,
      lastFiveConfirmedSignals,
      noSignalMessage,
      noRepaintWarnings,
      rrCalculation: lastSignal ? `${lastSignal.rewardPoints.toFixed(2)} / ${lastSignal.riskPoints.toFixed(2)} = ${lastSignal.rr.toFixed(2)}R` : null,
      stopLossSource: lastSignal?.stopLossDetail.source ?? null,
      takeProfitSource: lastSignal?.takeProfitDetail.source ?? null,
      scoreBreakdown: lastSignal?.scoreBreakdown ?? null,
      lastCandidateDebug: candidateDebug.at(-1) ?? null,
      noRepaintValidation,
      calculationTimeMs,
      generationTimeMs: calculationTimeMs,
      cacheStatus: "miss",
    },
  };

  if (resultCache.size >= 50) resultCache.delete(resultCache.keys().next().value ?? "");
  resultCache.set(cacheKey, result);
  return result;
}

export function generateHistoricalSignals(input: EntryEngineInput): EntryEngineResult {
  return generateTradeSignals(input);
}

export function evaluateSetup(
  input: EntryEngineInput,
  candles: Candle[],
  setup: MarketSetup,
  settings: EntryEngineSettings,
  resolveSnapshot?: (candleIndex: number) => HistoricalSnapshot | null,
): SignalEvaluation {
  const rejectionReasons: string[] = [];
  const rules = MODE_RULES[input.mode];
  const calibrationMode = input.mode === "CALIBRATION";
  const normalMode = input.mode === "NORMAL_SCALP";
  const easyMode = input.mode === "EASY_SCALP" || calibrationMode;
  const confirmationWindowCandles = rules.confirmationWindowCandles ?? settings.confirmationWindowCandles;
  const triggerIndex = triggerIndexFor(setup) ?? setup.updatedAtIndex;
  const confirmationSearch = findConfirmation(
    input,
    candles,
    setup,
    triggerIndex,
    confirmationWindowCandles,
    calibrationMode,
  );

  if (!hasTriggerState(setup)) rejectionReasons.push(`Setup ${setup.id} never reached TRIGGER.`);
  if (setup.direction !== "BULLISH" && setup.direction !== "BEARISH") rejectionReasons.push("Setup direction is neutral.");
  if (rejectionReasons.length) {
    return buildEvaluation({
      setup,
      signal: null,
      mode: input.mode,
      status: "REJECTED",
      windowRemaining: Math.max(0, confirmationWindowCandles),
      finalSignalScore: null,
      rejectionReasons,
      nextRequiredAction: "Wait for a valid Phase 4 TRIGGER setup with bullish or bearish direction.",
    });
  }

  if (confirmationSearch.status !== "CONFIRMED" || confirmationSearch.index === null) {
    return buildEvaluation({
      setup,
      signal: null,
      mode: input.mode,
      status: confirmationSearch.status,
      windowRemaining: confirmationSearch.windowRemaining,
      finalSignalScore: null,
      rejectionReasons: [confirmationSearch.reason],
      nextRequiredAction: confirmationSearch.nextRequiredAction,
    });
  }

  const confirmationIndex = confirmationSearch.index;
  const atr = currentAtr(input, candles, confirmationIndex);
  const candle = candles[confirmationIndex];
  const previous = candles[confirmationIndex - 1];

  const snapshot = resolveSnapshot?.(confirmationIndex) ?? null;
  const evaluationInput = snapshot
    ? { ...input, context: snapshot.context, candleReading: snapshot.candleReading }
    : input;
  const evaluationSetup = snapshot
    ? rescoreSetup(setup, snapshot.context, snapshot.candleReading)
    : setup;
  const direction = evaluationSetup.direction as "BULLISH" | "BEARISH";
  const modeConfig = MODE_CONFIG[input.mode];
  
  if (evaluationSetup.score < rules.setupScore) rejectionReasons.push(`Phase 4 setup score is ${evaluationSetup.score}; ${input.mode} requires setup score ${rules.setupScore}.`);
  if (!calibrationMode && !normalMode && (evaluationInput.context.wait.shouldWait || evaluationInput.context.regime.regime === "WAIT")) rejectionReasons.push(`Market context is WAIT: ${evaluationInput.context.wait.waitReasons[0] ?? evaluationInput.context.regime.reason}`);
  
  // Reversal risk filtering based on mode config
  if (!calibrationMode && modeConfig.reversalRiskMode !== "WARNING_ONLY") {
    if (modeConfig.reversalRiskMode === "BLOCK_HIGH" && (evaluationSetup.antiReversal.reversalRisk === "HIGH" || evaluationInput.candleReading?.reversalWarning.reversalRisk === "HIGH")) {
      rejectionReasons.push("Reversal risk is HIGH.");
    } else if (modeConfig.reversalRiskMode === "BLOCK_MEDIUM_HIGH" && (evaluationSetup.antiReversal.reversalRisk === "HIGH" || evaluationSetup.antiReversal.reversalRisk === "MEDIUM" || evaluationInput.candleReading?.reversalWarning.reversalRisk === "HIGH" || evaluationInput.candleReading?.reversalWarning.reversalRisk === "MEDIUM")) {
      rejectionReasons.push("Reversal risk is HIGH or MEDIUM.");
    }
  }
  
  // HTF bias validation based on mode config
  const htfBias = evaluationInput.context.htfBias.bias as "BULLISH" | "BEARISH" | "NEUTRAL" | string;
  const htfAligned = htfBias === direction;
  const htfNeutral = htfBias === "NEUTRAL" || htfBias === "RANGING" || htfBias === "UNKNOWN";
  const htfOpposed = htfBias === (direction === "BULLISH" ? "BEARISH" : "BULLISH");
  const stronglyOpposed = htfOpposed && evaluationInput.context.htfBias.strength >= 65;
  
  // NORMAL_SCALP: allow neutral, reject opposite if strong
  // PRO_TRADER: require aligned
  if (modeConfig.rejectOppositeHTF && stronglyOpposed) {
    rejectionReasons.push("HTF strongly opposes this direction.");
  }
  if (input.mode === "PRO_TRADER" && !htfAligned && !modeConfig.allowNeutralHTF) {
    rejectionReasons.push("PRO_TRADER requires HTF alignment.");
  }
  if (input.mode === "PRO_TRADER" && (!evaluationSetup.relatedDisplacement || !evaluationSetup.relatedStructure || (!evaluationSetup.relatedSweep && evaluationSetup.relatedStructure.type !== "BOS"))) {
    rejectionReasons.push("PRO_TRADER requires sweep/BOS, displacement, and structure-shift evidence.");
  }
  if (input.mode === "PRO_TRADER" && evaluationInput.context.session.sessionQuality < 70) rejectionReasons.push("PRO_TRADER requires good session quality.");
  if (!calibrationMode && !normalMode && (evaluationInput.context.regime.regime === "CHOPPY" || evaluationInput.context.regime.chopRisk >= 70)) rejectionReasons.push("Market is choppy.");
  if (!calibrationMode && !normalMode && evaluationInput.context.volatility.state === "EXTREME_VOLATILITY") rejectionReasons.push("Volatility is extreme.");
  if (evaluationSetup.warnings.some(isExecutionWarning)) rejectionReasons.push("News, spread, or slippage warning is active.");

  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = range > 0 ? body / range : 0;
  const minimumBodyRatio = normalMode ? 0.15 : 0.2;
  if (!calibrationMode && bodyRatio < minimumBodyRatio) rejectionReasons.push("Latest candle is weak or doji-like.");
  if (!calibrationMode && atr > 0 && range > atr * 1.8) rejectionReasons.push("Entry would chase an oversized candle.");
  if (distanceToZone(candle.close, evaluationSetup) > atr * rules.extensionAtr) rejectionReasons.push("Price is too extended from the setup zone.");
  if (direction === "BULLISH" && candle.close < evaluationSetup.setupZone.minPrice) rejectionReasons.push("Price closed below the bullish setup zone.");
  if (direction === "BEARISH" && candle.close > evaluationSetup.setupZone.maxPrice) rejectionReasons.push("Price closed above the bearish setup zone.");
  const unfavorableLocation = direction === "BULLISH"
    ? evaluationInput.context.premiumDiscount?.zone === "DEEP_PREMIUM" && evaluationSetup.type !== "COMPRESSION_BREAKOUT"
    : evaluationInput.context.premiumDiscount?.zone === "DEEP_DISCOUNT" && evaluationSetup.type !== "COMPRESSION_BREAKOUT";
  if (!easyMode && !normalMode && unfavorableLocation) {
    rejectionReasons.push(direction === "BULLISH" ? "BUY is in deep premium without a breakout model." : "SELL is in deep discount without a breakdown model.");
  }
  const oppositeHtf = direction === "BULLISH" ? "bearish" : "bullish";
  const latestOppositeDisplacement = hasLatestOppositeDisplacement(input.structure.markers, direction, confirmationIndex, triggerIndex);
  if (!calibrationMode && !normalMode && latestOppositeDisplacement) rejectionReasons.push(`${oppositeHtf.toLowerCase()} displacement just appeared.`);

  const confirmation = evaluateConfirmation(candle, previous, evaluationSetup, atr, calibrationMode, {
    isTriggerCandle: confirmationIndex === triggerIndex,
    candleIndex: confirmationIndex,
  });
  if (!confirmation.confirmed) rejectionReasons.push("Latest closed candle did not confirm entry.");

  const stop = calculateStopLoss(evaluationSetup, candles, confirmationIndex, candle.close, atr, settings.atrBufferMultiplier, calibrationMode, input.mode);
  if (!stop) rejectionReasons.push("No valid structural stop loss is available.");
  const target = stop
    ? calculateTakeProfit(evaluationInput, evaluationSetup, candle.close, stop.riskPoints, rules.rr, candle.timestamp)
    : null;
  if (!target) rejectionReasons.push("No realistic liquidity target meets the required RR.");
  const rr = stop && target ? calculateRiskReward(direction, candle.close, stop.price, target.tp1) : null;
  if (!rr || rr.risk <= 0 || rr.reward <= 0) rejectionReasons.push("Risk or reward is not positive.");
  else if (rr.rr < rules.rr) rejectionReasons.push(`RR is ${rr.rr.toFixed(2)} and ${input.mode} requires ${rules.rr.toFixed(1)}.`);

  if (rejectionReasons.length || !stop || !target || !rr) {
    return buildEvaluation({
      setup: evaluationSetup,
      signal: null,
      mode: input.mode,
      status: "REJECTED",
      windowRemaining: confirmationSearch.windowRemaining,
      finalSignalScore: null,
      rejectionReasons: unique(rejectionReasons),
      nextRequiredAction: nextActionForRejection(unique(rejectionReasons), input.mode),
    });
  }

  const scoreBreakdown = calculateSignalScore(evaluationInput, evaluationSetup, confirmation.quality, stop, target, rr.rr, atr);
  const score = Object.values(scoreBreakdown).reduce((total, value) => total + value, 0);
  if (score < rules.signalScore) {
    const reasons = [`Rejected because final score ${score} is below ${modeLabel(input.mode)} requirement ${rules.signalScore}.`];
    return buildEvaluation({
      setup: evaluationSetup,
      signal: null,
      mode: input.mode,
      status: "REJECTED",
      windowRemaining: confirmationSearch.windowRemaining,
      finalSignalScore: score,
      rejectionReasons: reasons,
      nextRequiredAction: "Improve confirmation quality, RR, SL/TP quality, or context/session quality before confirming this setup.",
    });
  }

  const rapid = qualifiesForRapid(evaluationInput, evaluationSetup, triggerIndex, confirmationIndex, rr.rr);
  const type = rapid
    ? direction === "BULLISH" ? "RAPID_BUY" : "RAPID_SELL"
    : direction === "BULLISH" ? "CONFIRMED_BUY" : "CONFIRMED_SELL";
  const evidenceIndexes = [
    ...evaluationSetup.relatedLtfCandles,
    evaluationSetup.relatedSweep?.confirmedAtIndex,
    evaluationSetup.relatedDisplacement?.confirmedAtIndex,
    evaluationSetup.relatedStructure?.confirmedAtIndex,
    evaluationSetup.relatedFvg?.confirmedAtIndex,
    confirmationIndex,
  ].filter((value): value is number => typeof value === "number");
  const maxEvidenceIndex = Math.max(...evidenceIndexes);
  if (maxEvidenceIndex > confirmationIndex) {
    return buildEvaluation({
      setup: evaluationSetup,
      signal: null,
      mode: input.mode,
      status: "REJECTED",
      windowRemaining: confirmationSearch.windowRemaining,
      finalSignalScore: score,
      rejectionReasons: ["Setup evidence includes a future candle beyond confirmation."],
      nextRequiredAction: "Wait for causal setup evidence that exists at or before the confirmation candle.",
    });
  }
  const contextCloseTimes = [
    evaluationInput.context.itfCandles.findLast((item) => item.closeTime <= candle.timestamp)?.closeTime,
    evaluationInput.context.htfCandles.findLast((item) => item.closeTime <= candle.timestamp)?.closeTime,
  ].filter((value): value is number => typeof value === "number");
  const noRepaintPassed = maxEvidenceIndex <= confirmationIndex && triggerIndex <= confirmationIndex;
  const warnings = [...evaluationSetup.warnings];
  if (calibrationMode && (evaluationInput.context.wait.shouldWait || evaluationInput.context.regime.regime === "WAIT")) warnings.push(`CALIBRATION warning: context is WAIT (${evaluationInput.context.wait.waitReasons[0] ?? evaluationInput.context.regime.reason}).`);
  if (calibrationMode && (evaluationSetup.antiReversal.reversalRisk === "HIGH" || evaluationInput.candleReading?.reversalWarning.reversalRisk === "HIGH")) warnings.push("CALIBRATION warning: reversal risk is HIGH.");
  if (calibrationMode && evaluationInput.context.volatility.state === "EXTREME_VOLATILITY") warnings.push("CALIBRATION warning: volatility is extreme.");
  if (calibrationMode && evaluationInput.context.session.sessionQuality < 50) warnings.push("CALIBRATION warning: session quality is low.");
  if (calibrationMode && latestOppositeDisplacement) warnings.push(`CALIBRATION warning: ${oppositeHtf.toLowerCase()} displacement appeared near the trigger.`);
  if (normalMode && unfavorableLocation) warnings.push(`NORMAL warning: ${direction === "BULLISH" ? "BUY is in deep premium" : "SELL is in deep discount"} without a breakout model.`);
  if (normalMode && latestOppositeDisplacement) warnings.push(`NORMAL warning: ${oppositeHtf.toLowerCase()} displacement appeared near the trigger.`);
  if (rapid) warnings.push("Rapid signal is aggressive and requires smaller risk.");
  const signal: TradeSignal = {
    id: `signal:${input.symbol}:${input.timeframe}:${input.mode}:${setup.id}:${candle.timestamp}:${direction}`,
    type,
    direction,
    status: "CONFIRMED",
    sourceSetupId: evaluationSetup.id,
    setupType: evaluationSetup.type,
    strategyModel: strategyName(evaluationSetup.type),
    mode: input.mode,
    timestamp: candle.timestamp,
    candleIndex: confirmationIndex,
    confirmedAtIndex: confirmationIndex,
    timeframe: input.timeframe,
    session: evaluationInput.context.session.session,
    entryPrice: round(candle.close),
    stopLoss: stop.price,
    takeProfit: target.tp1,
    takeProfit2: target.tp2,
    takeProfit3: target.tp3,
    riskPoints: rr.risk,
    rewardPoints: rr.reward,
    rr: rr.rr,
    score,
    confidence: confidenceFor(score),
    positionSizeSuggestion: round(settings.maxRiskAmount / rr.risk, 4),
    maxRiskAmount: settings.maxRiskAmount,
    invalidationLevel: evaluationSetup.invalidationLevel.price,
    reasons: [...evaluationSetup.reasons, confirmation.reason, stop.reason, target.reason],
    warnings,
    rejectionReasons: [],
    relatedMarkers: [evaluationSetup.relatedLiquidity?.id, evaluationSetup.relatedSweep?.id, evaluationSetup.relatedDisplacement?.id, evaluationSetup.relatedStructure?.id, evaluationSetup.relatedFvg?.id].filter((value): value is string => Boolean(value)),
    noRepaintProof: {
      status: noRepaintPassed ? "PASS" : "WARNING",
      signalIndex: confirmationIndex,
      latestAllowedCandleIndex: confirmationIndex,
      usedMarkerIndexes: [...new Set(evidenceIndexes)].sort((a, b) => a - b),
      usedContextCloseTimes: contextCloseTimes,
      usedSetupId: evaluationSetup.id,
      passed: noRepaintPassed,
      lastAvailableIndex: confirmationIndex,
      maxEvidenceIndex,
      message: noRepaintPassed
        ? "Signal uses closed candles and evidence available at confirmation; immutable trade levels are retained."
        : "One or more evidence indexes are after confirmation.",
    },
    stopLossDetail: stop,
    takeProfitDetail: target,
    scoreBreakdown,
  };
  return buildEvaluation({
    setup: evaluationSetup,
    signal,
    mode: input.mode,
    status: "CONFIRMED",
    windowRemaining: confirmationSearch.windowRemaining,
    finalSignalScore: score,
    rejectionReasons: [],
    nextRequiredAction: "Signal confirmed; use immutable entry, SL, TP, and RR for chart and backtest.",
  });
}

export function calculateStopLoss(
  setup: MarketSetup,
  candles: Candle[],
  candleIndex: number,
  entry: number,
  atr: number,
  bufferMultiplier = DEFAULT_SETTINGS.atrBufferMultiplier,
  calibrationMode = false,
  mode?: EntryMode,
): StopLossResult | null {
  if (setup.direction !== "BULLISH" && setup.direction !== "BEARISH") return null;
  const recent = candles.slice(Math.max(0, candleIndex - 6), candleIndex + 1);
  if (recent.length === 0 || atr <= 0) return null;
  const buffer = atr * bufferMultiplier;
  const candidatePrices = setup.direction === "BULLISH"
    ? [
      { price: setup.invalidationLevel.price, source: setup.invalidationLevel.source },
      { price: setup.setupZone.minPrice, source: "SETUP_ZONE" },
      { price: setup.relatedSweep?.sweepPrice, source: "SWEEP_EXTREME" },
      { price: candles[candleIndex]?.low, source: "CONFIRMATION_CANDLE_LOW" },
      { price: Math.min(...recent.map((candle) => candle.low)), source: "PULLBACK_EXTREME" },
    ]
    : [
      { price: setup.invalidationLevel.price, source: setup.invalidationLevel.source },
      { price: setup.setupZone.maxPrice, source: "SETUP_ZONE" },
      { price: setup.relatedSweep?.sweepPrice, source: "SWEEP_EXTREME" },
      { price: candles[candleIndex]?.high, source: "CONFIRMATION_CANDLE_HIGH" },
      { price: Math.max(...recent.map((candle) => candle.high)), source: "PULLBACK_EXTREME" },
    ];
  const validCandidates = candidatePrices.filter((candidate): candidate is { price: number; source: string } => Number.isFinite(candidate.price));
  const valid = validCandidates.map((candidate) => candidate.price);

  if (mode === "NORMAL_SCALP") {
    const mediumCandidates = validCandidates
      .map((candidate) => ({
        ...candidate,
        distance: setup.direction === "BULLISH" ? entry - candidate.price : candidate.price - entry,
      }))
      .filter((candidate) => candidate.distance >= atr * 0.15 && candidate.distance <= atr * 2)
      .sort((a, b) => a.distance - b.distance);
    const selected = mediumCandidates[0];
    if (!selected) return null;
    const mediumPrice = setup.direction === "BULLISH" ? selected.price - buffer : selected.price + buffer;
    const mediumRisk = setup.direction === "BULLISH" ? entry - mediumPrice : mediumPrice - entry;
    if (mediumRisk <= 0) return null;
    return {
      price: round(mediumPrice),
      source: selected.source,
      buffer: round(buffer),
      riskPoints: round(mediumRisk),
      reason: `${setup.direction === "BULLISH" ? "BUY" : "SELL"} normal stop uses the nearest valid structural ${selected.source.toLowerCase().replaceAll("_", " ")} within 0.15-2.0 ATR, plus an ATR buffer.`,
    };
  }

  const structural = setup.direction === "BULLISH" ? Math.min(...valid) : Math.max(...valid);
  const price = setup.direction === "BULLISH" ? structural - buffer : structural + buffer;
  const riskPoints = setup.direction === "BULLISH" ? entry - price : price - entry;
  const minStopAtr = 0.12;
  const maxStopAtr = calibrationMode ? 8 : 5;
  if (riskPoints <= atr * minStopAtr || riskPoints > atr * maxStopAtr) {
    if (!calibrationMode) return null;
    const fallbackStructural = setup.direction === "BULLISH"
      ? Math.min(setup.setupZone.minPrice, Math.min(...recent.map((candle) => candle.low)))
      : Math.max(setup.setupZone.maxPrice, Math.max(...recent.map((candle) => candle.high)));
    const fallbackPrice = setup.direction === "BULLISH" ? fallbackStructural - buffer : fallbackStructural + buffer;
    const fallbackRisk = setup.direction === "BULLISH" ? entry - fallbackPrice : fallbackPrice - entry;
    if (fallbackRisk <= atr * 0.08 || fallbackRisk > atr * maxStopAtr) return null;
    if ((setup.direction === "BULLISH" && fallbackPrice >= entry) || (setup.direction === "BEARISH" && fallbackPrice <= entry)) return null;
    return {
      price: round(fallbackPrice),
      source: "PULLBACK_EXTREME",
      buffer: round(buffer),
      riskPoints: round(fallbackRisk),
      reason: `${setup.direction === "BULLISH" ? "BUY" : "SELL"} calibration stop uses the recent pullback extreme with an ATR buffer because the structural stop was outside the test range.`,
    };
  }
  if ((setup.direction === "BULLISH" && price >= entry) || (setup.direction === "BEARISH" && price <= entry)) return null;
  const source = setup.relatedSweep ? "SWEEP_EXTREME" : setup.invalidationLevel.source;
  return {
    price: round(price),
    source,
    buffer: round(buffer),
    riskPoints: round(riskPoints),
    reason: `${setup.direction === "BULLISH" ? "BUY" : "SELL"} stop is beyond ${source.toLowerCase().replaceAll("_", " ")} with an ATR buffer.`,
  };
}

export function calculateTakeProfit(
  input: EntryEngineInput,
  setup: MarketSetup,
  entry: number,
  risk: number,
  minimumRr: number,
  availableAtTimestamp = Number.POSITIVE_INFINITY,
): TakeProfitResult | null {
  if (setup.direction !== "BULLISH" && setup.direction !== "BEARISH" || risk <= 0) return null;
  const targets = collectTargets(input.context.levels, setup, entry, setup.direction, availableAtTimestamp);
  const insertion = lowerBound(targets, entry);
  const directionalTargets = setup.direction === "BULLISH" ? targets.slice(insertion) : targets.slice(0, insertion).reverse();
  let selected = directionalTargets.find((target) => Math.abs(target - entry) / risk >= minimumRr);
  const allowFallback = input.mode === "CALIBRATION" || input.mode === "EASY_SCALP";
  if (selected === undefined && directionalTargets.length > 0 && !allowFallback) {
    selected = directionalTargets[0];
  }
  if (selected === undefined && allowFallback) {
    const fallback = setup.direction === "BULLISH" ? entry + risk * minimumRr : entry - risk * minimumRr;
    return {
      tp1: round(fallback),
      tp2: round(setup.direction === "BULLISH" ? entry + risk * Math.max(1.2, minimumRr + 0.5) : entry - risk * Math.max(1.2, minimumRr + 0.5)),
      tp3: null,
      source: `${minimumRr.toFixed(1)}R_CALIBRATION_FALLBACK`,
      rewardPoints: round(Math.abs(fallback - entry)),
      reason: "Nearest structural target did not meet minimum RR, so calibration/easy mode uses a clearly marked fixed-R fallback target.",
    };
  }
  const index = selected === undefined ? -1 : targets.indexOf(selected);
  if (selected === undefined) {
    return null;
  }
  const nextIndex = setup.direction === "BULLISH" ? index + 1 : index - 1;
  const thirdIndex = setup.direction === "BULLISH" ? index + 2 : index - 2;
  return {
    tp1: round(selected),
    tp2: targets[nextIndex] === undefined ? null : round(targets[nextIndex]),
    tp3: targets[thirdIndex] === undefined ? null : round(targets[thirdIndex]),
    source: setup.targetLiquidity?.price === selected ? setup.targetLiquidity.targetType : "SORTED_LIQUIDITY_LEVEL",
    rewardPoints: round(Math.abs(selected - entry)),
    reason: "Target is the nearest reachable unswept liquidity or structure level that satisfies minimum RR.",
  };
}

export function calculateRiskReward(direction: "BULLISH" | "BEARISH", entry: number, stop: number, target: number): { risk: number; reward: number; rr: number } | null {
  const risk = direction === "BULLISH" ? entry - stop : stop - entry;
  const reward = direction === "BULLISH" ? target - entry : entry - target;
  if (risk <= 0 || reward <= 0) return null;
  return { risk: round(risk), reward: round(reward), rr: round(reward / risk, 2) };
}

export function clearEntryEngineCache(): void {
  resultCache.clear();
}

/**
 * Normalize direction/signal types to bias values for comparison.
 * BUY and BULLISH both map to BULLISH, SELL and BEARISH both map to BEARISH.
 */
function directionToBias(direction: "BUY" | "SELL" | "BULLISH" | "BEARISH" | string): "BULLISH" | "BEARISH" | "NEUTRAL" {
  if (direction === "BUY" || direction === "BULLISH") return "BULLISH";
  if (direction === "SELL" || direction === "BEARISH") return "BEARISH";
  return "NEUTRAL";
}

function evaluateConfirmation(
  candle: Candle,
  previous: Candle | undefined,
  setup: MarketSetup,
  atr: number,
  calibrationMode = false,
  options: { isTriggerCandle?: boolean; candleIndex?: number } = {},
): { confirmed: boolean; quality: number; reason: string } {
  const bullish = setup.direction === "BULLISH";
  const directionClose = bullish ? candle.close > candle.open : candle.close < candle.open;
  const breaksPrevious = previous ? bullish ? candle.close > previous.high : candle.close < previous.low : false;
  const engulfing = previous ? bullish
    ? candle.open <= previous.close && candle.close >= previous.open && previous.close < previous.open
    : candle.open >= previous.close && candle.close <= previous.open && previous.close > previous.open : false;
  const rejectsZone = bullish
    ? candle.low <= setup.setupZone.maxPrice && candle.close > setup.setupZone.midpoint && candle.close > candle.open
    : candle.high >= setup.setupZone.minPrice && candle.close < setup.setupZone.midpoint && candle.close < candle.open;
  const range = candle.high - candle.low;
  const body = Math.abs(candle.close - candle.open);
  const closePosition = range > 0
    ? bullish ? (candle.close - candle.low) / range : (candle.high - candle.close) / range
    : 0;
  const closesNearDirectionalExtreme = closePosition >= (calibrationMode ? 0.55 : 0.65);
  const relatedStructureBreak = setup.relatedStructure?.direction === setup.direction &&
    setup.relatedStructure.confirmedAtIndex <= (options.candleIndex ?? Number.POSITIVE_INFINITY);
  const displacement = directionClose && atr > 0 && body >= atr * (calibrationMode ? 0.45 : 0.7) && body / Math.max(range, Number.EPSILON) >= (calibrationMode ? 0.45 : 0.6);
  const calibrationFollowThrough = calibrationMode && directionClose && body / Math.max(range, Number.EPSILON) >= 0.35;
  const triggerConfirmation = Boolean(options.isTriggerCandle) &&
    directionClose &&
    closesNearDirectionalExtreme &&
    (breaksPrevious || relatedStructureBreak || rejectsZone);
  const followThroughConfirmation = directionClose &&
    !options.isTriggerCandle &&
    (breaksPrevious || engulfing || rejectsZone || displacement || calibrationFollowThrough);
  const confirmed = triggerConfirmation || followThroughConfirmation;
  const quality = clamp(
    (breaksPrevious ? 5 : 0) +
    (relatedStructureBreak ? 3 : 0) +
    (engulfing ? 4 : 0) +
    (rejectsZone ? 3 : 0) +
    (displacement ? 3 : 0) +
    (closesNearDirectionalExtreme ? 2 : 0) +
    (calibrationFollowThrough ? 2 : 0),
    0,
    15,
  );
  const labels = [
    triggerConfirmation && "trigger candle confirmed immediately",
    breaksPrevious && "closed through the previous extreme",
    relatedStructureBreak && "confirmed available minor structure",
    engulfing && "engulfed the pullback",
    rejectsZone && "rejected the setup zone",
    closesNearDirectionalExtreme && (bullish ? "closed near the high" : "closed near the low"),
    displacement && "displaced from retracement",
    calibrationFollowThrough && "closed directionally in calibration mode",
  ].filter(Boolean);
  return { confirmed, quality, reason: confirmed ? `Confirmation candle ${labels.join(", ")}.` : "Confirmation candle did not show directional follow-through." };
}

function findConfirmation(
  input: EntryEngineInput,
  candles: Candle[],
  setup: MarketSetup,
  triggerIndex: number,
  maxBars: number,
  calibrationMode = false,
): ConfirmationSearchResult {
  const lastIndex = candles.length - 1;
  const modeConfig = MODE_CONFIG[input.mode];
  
  if (lastIndex < triggerIndex || triggerIndex < 0) {
    return {
      status: "PENDING_CONFIRMATION",
      index: null,
      windowRemaining: maxBars,
      reason: "Waiting for the closed trigger candle before checking confirmation.",
      nextRequiredAction: `Waiting for confirmation candle. ${maxBars} candles remaining in ${modeConfig.label} mode.`,
    };
  }

  const start = Math.max(0, triggerIndex);
  const end = Math.min(lastIndex, triggerIndex + maxBars);
  for (let index = start; index <= end; index += 1) {
    const atr = currentAtr(input, candles, index);
    const isTriggerCandle = index === triggerIndex;
    
    // Check if trigger candle can be used as confirmation if allowed
    if (isTriggerCandle && modeConfig.allowTriggerAsConfirmation) {
      if (evaluateConfirmation(candles[index], candles[index - 1], setup, atr, calibrationMode, {
        isTriggerCandle: true,
        candleIndex: index,
      }).confirmed) {
        return {
          status: "CONFIRMED",
          index,
          windowRemaining: maxBars,
          reason: "Trigger candle itself satisfied confirmation criteria.",
          nextRequiredAction: "Calculate Phase 5 score, SL, TP, and RR.",
        };
      }
    } else if (index > triggerIndex) {
      // Check subsequent candles for confirmation
      if (evaluateConfirmation(candles[index], candles[index - 1], setup, atr, calibrationMode, {
        isTriggerCandle: false,
        candleIndex: index,
      }).confirmed) {
        return {
          status: "CONFIRMED",
          index,
          windowRemaining: Math.max(0, maxBars - (index - triggerIndex)),
          reason: "Closed confirmation candle is available.",
          nextRequiredAction: "Calculate Phase 5 score, SL, TP, and RR.",
        };
      }
    }

    if (isInvalidatedBeforeConfirmation(setup, candles[index])) {
      return {
        status: "INVALIDATED",
        index: null,
        windowRemaining: Math.max(0, maxBars - Math.max(0, index - triggerIndex)),
        reason: "Invalidated before confirmation.",
        nextRequiredAction: "Stop tracking this candidate because price closed beyond the setup invalidation level before confirmation.",
      };
    }
  }

  const candlesAfterTrigger = Math.max(0, lastIndex - triggerIndex);
  const remaining = Math.max(0, maxBars - candlesAfterTrigger);
  if (candlesAfterTrigger < maxBars) {
    return {
      status: "PENDING_CONFIRMATION",
      index: null,
      windowRemaining: remaining,
      reason: `Waiting for confirmation candle within ${modeConfig.label} window. ${remaining} candle${remaining === 1 ? "" : "s"} remaining.`,
      nextRequiredAction: `Waiting for confirmation candle. ${remaining} candle${remaining === 1 ? "" : "s"} remaining.`,
    };
  }

  return {
    status: "EXPIRED_CONFIRMATION",
    index: null,
    windowRemaining: 0,
    reason: `Rejected because confirmation window (${maxBars} candles) expired in ${modeConfig.label} mode.`,
    nextRequiredAction: "Wait for a new Phase 4 trigger; this candidate did not confirm within the configured window.",
  };
}

function isInvalidatedBeforeConfirmation(setup: MarketSetup, candle: Candle): boolean {
  if (setup.direction === "BULLISH") return candle.close <= setup.invalidationLevel.price;
  if (setup.direction === "BEARISH") return candle.close >= setup.invalidationLevel.price;
  return false;
}

function calculateSignalScore(input: EntryEngineInput, setup: MarketSetup, confirmationQuality: number, stop: StopLossResult, target: TakeProfitResult, rr: number, atr: number): SignalScoreBreakdown {
  if (input.mode === "NORMAL_SCALP") {
    return calculateNormalSignalScore(input, setup, confirmationQuality, stop, target, rr, atr);
  }

  const aligned = input.context.htfBias.bias === setup.direction;
  const neutral = ["NEUTRAL", "RANGING", "UNKNOWN"].includes(input.context.htfBias.bias);
  const riskAtr = stop.riskPoints / Math.max(atr, Number.EPSILON);
  const volatility = input.context.volatility.state;
  
  // Practical balanced weights: sum to 100 points
  return {
    phase4Setup: clamp(Math.round(setup.score * 0.35), 0, 35),
    contextAlignment: aligned ? 10 : neutral ? 7 : 2,
    confirmationCandle: clamp(confirmationQuality / 15 * 25, 0, 25),
    stopLossQuality: riskAtr >= 0.25 && riskAtr <= 3 ? 15 : riskAtr <= 4 ? 9 : 3,
    targetQuality: clamp(8 + Math.min(5, Math.max(0, (rr - 1) * 3)) - (target.source.includes("FALLBACK") ? 2 : 0), 0, 8),
    sessionQuality: clamp(Math.round(input.context.session.sessionQuality * 0.04), 0, 4),
    volatilityQuality: volatility === "NORMAL_VOLATILITY" ? 2 : volatility === "HIGH_VOLATILITY" ? 1 : volatility === "LOW_VOLATILITY" ? 1 : 0,
    antiReversal: setup.antiReversal.reversalRisk === "LOW" ? 1 : 0,
  };
}

function calculateNormalSignalScore(input: EntryEngineInput, setup: MarketSetup, confirmationQuality: number, stop: StopLossResult, target: TakeProfitResult, rr: number, atr: number): SignalScoreBreakdown {
  const aligned = input.context.htfBias.bias === setup.direction;
  const neutral = ["NEUTRAL", "RANGING", "UNKNOWN"].includes(input.context.htfBias.bias);
  const directionPreferred = input.context.score.directionPreference === setup.direction;
  const contextWait = input.context.wait.shouldWait || input.context.regime.regime === "WAIT";
  const choppy = input.context.regime.regime === "CHOPPY" || input.context.regime.chopRisk >= 70;
  const contextBase = aligned ? 100 : neutral ? 75 : directionPreferred ? 65 : 35;
  const contextQuality = clamp(contextBase - (contextWait ? 12 : 0) - (choppy ? 16 : 0), 25, 100);
  const riskAtr = stop.riskPoints / Math.max(atr, Number.EPSILON);
  const stopQuality = riskAtr >= 0.25 && riskAtr <= 3 ? 100 : riskAtr <= 4 ? 60 : 25;
  const targetQuality = clamp(70 + Math.min(30, Math.max(0, rr - MODE_CONFIG.NORMAL_SCALP.minRR) * 30) - (target.source.includes("FALLBACK") ? 20 : 0), 0, 100);
  const volatility = input.context.volatility.state;
  const volatilityQuality = volatility === "NORMAL_VOLATILITY" ? 100 : volatility === "HIGH_VOLATILITY" ? 70 : volatility === "LOW_VOLATILITY" ? 65 : 35;
  const antiReversalQuality = setup.antiReversal.reversalRisk === "LOW" ? 100 : setup.antiReversal.reversalRisk === "MEDIUM" ? 55 : 0;

  // Balanced practical weights (totals 100 points):
  // phase4Setup: 0.35 * ~100 = 35
  // confirmationCandle: 0.25 * ~100 = 25
  // stopLossQuality: 0.15 * ~100 = 15
  // contextAlignment: 0.10 * ~100 = 10
  // targetQuality: 0.08 * ~100 = 8
  // sessionQuality: 0.04 * ~100 = 4
  // volatilityQuality: 0.02 * ~100 = 2
  // antiReversal: 0.01 * ~100 = 1
  return {
    phase4Setup: clamp(Math.round(setup.score * 0.35), 0, 35),
    contextAlignment: clamp(Math.round(contextQuality * 0.10), 0, 10),
    confirmationCandle: clamp(Math.round(confirmationQuality / 15 * 25), 0, 25),
    stopLossQuality: clamp(Math.round(stopQuality * 0.15), 0, 15),
    targetQuality: clamp(Math.round(targetQuality * 0.08), 0, 8),
    sessionQuality: clamp(Math.round(input.context.session.sessionQuality * 0.04), 0, 4),
    volatilityQuality: clamp(Math.round(volatilityQuality * 0.02), 0, 2),
    antiReversal: clamp(Math.round(antiReversalQuality * 0.01), 0, 1),
  };
}

function collectTargets(
  levels: KeyLevel[],
  setup: MarketSetup,
  entry: number,
  direction: "BULLISH" | "BEARISH",
  availableAtTimestamp: number,
): number[] {
  const prices = levels
    .filter((level) =>
      !level.swept &&
      level.lastTouchedAt <= availableAtTimestamp &&
      (direction === "BULLISH" ? level.price > entry : level.price < entry),
    )
    .map((level) => level.price);
  const causalSetupTarget = setup.targetLiquidity && levels.some((level) =>
    level.price === setup.targetLiquidity?.price &&
    !level.swept &&
    level.lastTouchedAt <= availableAtTimestamp,
  );
  if (causalSetupTarget && setup.targetLiquidity && (direction === "BULLISH" ? setup.targetLiquidity.price > entry : setup.targetLiquidity.price < entry)) {
    prices.push(setup.targetLiquidity.price);
  }
  return [...new Set(prices)].sort((a, b) => a - b);
}

function qualifiesForRapid(input: EntryEngineInput, setup: MarketSetup, triggerIndex: number, confirmationIndex: number, rr: number): boolean {
  return setup.type === "LIQUIDITY_SWEEP_REVERSAL" &&
    setup.relatedSweep?.strength === 3 &&
    setup.relatedDisplacement?.direction === setup.direction &&
    setup.relatedStructure?.type === "MSS" &&
    setup.relatedStructure.direction === setup.direction &&
    setup.targetLiquidity !== null &&
    input.context.session.sessionQuality >= 75 &&
    setup.antiReversal.reversalRisk === "LOW" &&
    !setup.warnings.some((warning) => warning.toLowerCase().includes("chase")) &&
    confirmationIndex - triggerIndex <= 1 &&
    rr >= MODE_RULES[input.mode].rr;
}

function updateSignalStatus(signal: TradeSignal, candles: Candle[], maxAge: number): TradeSignal {
  const future = candles.slice(signal.confirmedAtIndex + 1);
  let status = signal.status;
  for (let offset = 0; offset < future.length; offset += 1) {
    const candle = future[offset];
    const stopHit = signal.direction === "BULLISH" ? candle.low <= signal.stopLoss : candle.high >= signal.stopLoss;
    const targetHit = signal.direction === "BULLISH" ? candle.high >= signal.takeProfit : candle.low <= signal.takeProfit;
    const invalidated = signal.direction === "BULLISH" ? candle.close <= signal.invalidationLevel : candle.close >= signal.invalidationLevel;
    if (stopHit) { status = "SL_HIT"; break; }
    if (targetHit) { status = "TP_HIT"; break; }
    if (invalidated) { status = "INVALIDATED"; break; }
    status = offset + 1 > maxAge ? "EXPIRED" : "ACTIVE";
  }
  return status === signal.status ? signal : { ...signal, status };
}

function buildEvaluation(input: {
  setup: MarketSetup;
  signal: TradeSignal | null;
  mode: EntryMode;
  status: ConfirmationStatus;
  windowRemaining: number;
  finalSignalScore: number | null;
  rejectionReasons: string[];
  nextRequiredAction: string;
}): SignalEvaluation {
  const rejectionReasons = unique(input.rejectionReasons);
  return {
    setup: input.setup,
    signal: input.signal,
    rejectionReasons,
    confirmationStatus: input.status,
    debug: buildCandidateDebug({
      setup: input.setup,
      mode: input.mode,
      status: input.status,
      windowRemaining: input.windowRemaining,
      finalSignalScore: input.finalSignalScore,
      rejectionReason: rejectionReasons[0] ?? (input.signal ? "Accepted" : "No rejection reason recorded."),
      nextRequiredAction: input.nextRequiredAction,
    }),
  };
}

function buildCandidateDebug(input: {
  setup: MarketSetup;
  mode: EntryMode;
  status: ConfirmationStatus;
  windowRemaining: number;
  finalSignalScore: number | null;
  rejectionReason: string;
  nextRequiredAction: string;
}): SignalCandidateDebug {
  const rules = MODE_RULES[input.mode];
  return {
    setupId: input.setup.id,
    setupScore: input.setup.score,
    requiredSetupScore: rules.setupScore,
    finalSignalScore: input.finalSignalScore,
    requiredSignalScore: rules.signalScore,
    confirmationStatus: input.status,
    confirmationWindowRemaining: Math.max(0, input.windowRemaining),
    rejectionReason: input.rejectionReason,
    nextRequiredAction: input.nextRequiredAction,
  };
}

function buildNoTrade(input: EntryEngineInput, triggerSetups: MarketSetup[], reasons: string[], timestamp: number | null, message: string, requiredForSignal = buildRequiredForSignal(input.mode)): NoTradeResult {
  const nearest = [...input.setupScanner.setups].sort((a, b) => b.score - a.score)[0] ?? null;
  const fallbackReasons = triggerSetups.length === 0
    ? input.setupScanner.setups.length === 0
      ? ["No Phase 4 setup is currently available."]
      : [`No trade because the nearest setup is ${nearest?.state ?? "unavailable"}, not TRIGGER.`]
    : ["No trigger setup passed all entry filters."];
  return {
    status: "NO_TRADE",
    checkedSetups: input.setupScanner.setups.length,
    rejectionReasons: reasons.length ? reasons : fallbackReasons,
    message,
    nearestPossibleSetup: nearest ? `${nearest.type} ${nearest.direction} ${nearest.state} (${nearest.score}/100)` : null,
    requiredForSignal,
    timestamp,
  };
}

function buildRequiredForSignal(mode: EntryMode): string[] {
  const rules = MODE_RULES[mode];
  const confirmationWindow = rules.confirmationWindowCandles ?? DEFAULT_SETTINGS.confirmationWindowCandles;
  return [
    `Phase 4 TRIGGER setup with setup score >= ${rules.setupScore}`,
    `Final Phase 5 signal score >= ${rules.signalScore}`,
    `Closed directional confirmation candle within ${confirmationWindow} candles and RR >= ${rules.rr.toFixed(1)}`,
    "Valid structural SL, realistic liquidity TP, and reversal risk below HIGH",
  ];
}

function nextActionForRejection(reasons: string[], mode: EntryMode): string {
  const primary = reasons[0] ?? "";
  const rules = MODE_RULES[mode];
  if (primary.includes("Phase 4 setup score")) return `Setup score must be at least ${rules.setupScore}; wait for cleaner Phase 4 evidence.`;
  if (primary.includes("final score")) return `Final signal score must be at least ${rules.signalScore}; wait for stronger confirmation, RR, SL/TP, or context quality.`;
  if (primary.includes("RR")) return `Need RR >= ${rules.rr.toFixed(1)} with a valid stop and reachable target.`;
  if (primary.includes("confirmation")) return "Wait for a closed directional confirmation candle inside the confirmation window.";
  if (primary.includes("stop")) return "Need a structural stop on the correct side of entry.";
  if (primary.includes("target")) return "Need a causal liquidity target that supports the required RR.";
  if (primary.includes("Reversal risk is HIGH")) return "Wait until reversal risk is no longer HIGH.";
  return "Wait for a cleaner setup or stronger Phase 5 confirmation.";
}

function modeLabel(mode: EntryMode): string {
  return mode.replaceAll("_", " ");
}

function currentAtr(input: EntryEngineInput, candles: Candle[], candleIndex: number): number {
  const boundedIndex = Math.min(Math.max(0, candleIndex), Math.max(0, candles.length - 1));
  const structureAtr = input.structure.atr[boundedIndex];
  if (structureAtr && structureAtr > 0) return structureAtr;
  const ranges = candles
    .slice(Math.max(0, boundedIndex - 13), boundedIndex + 1)
    .map((candle) => candle.high - candle.low);
  return ranges.length ? ranges.reduce((total, value) => total + value, 0) / ranges.length : 0;
}

function createHistoricalSnapshotResolver(
  input: EntryEngineInput,
  candles: Candle[],
): (candleIndex: number) => HistoricalSnapshot | null {
  const cache = new Map<number, HistoricalSnapshot>();
  const canRebuildContext = input.context.itfCandles.length > 0 || input.context.htfCandles.length > 0;

  return (candleIndex) => {
    if (!canRebuildContext) return null;
    const boundedIndex = Math.min(Math.max(0, candleIndex), Math.max(0, candles.length - 1));
    const cached = cache.get(boundedIndex);
    if (cached) return cached;

    const availableCandles = candles.slice(0, boundedIndex + 1);
    const context = calculateMarketContext({
      candles: availableCandles,
      symbol: `${input.symbol}:entry-snapshot:${boundedIndex}`,
      timeframe: input.timeframe,
      startDate: input.startDate,
      endDate: availableCandles.at(-1)?.time ?? input.endDate,
      marketStructureSettings: input.structure.audit.markerSensitivitySettings,
      displayTimezone: input.context.session.displayTimezone,
    });
    const candleReading = analyzeCandleReading(availableCandles, {
      windowSize: 20,
      atrPeriod: input.structure.audit.markerSensitivitySettings.atrPeriod,
    });
    if (!candleReading) return null;
    const snapshot = { context, candleReading };
    cache.set(boundedIndex, snapshot);
    return snapshot;
  };
}

function rescoreSetup(
  setup: MarketSetup,
  context: MarketContextResult,
  candleReading: CandleReadingResult,
): MarketSetup {
  const location = context.premiumDiscount?.zone;
  const locationMatch = setup.direction === "BULLISH"
    ? location === "DISCOUNT" || location === "DEEP_DISCOUNT"
    : setup.direction === "BEARISH"
      ? location === "PREMIUM" || location === "DEEP_PREMIUM"
      : false;
  const psychologyMatch = setup.direction === "BULLISH"
    ? candleReading.sequence.pressure === "BUYERS_ACTIVE" || candleReading.scenarios.expectedBias === "BULLISH"
    : setup.direction === "BEARISH"
      ? candleReading.sequence.pressure === "SELLERS_ACTIVE" || candleReading.scenarios.expectedBias === "BEARISH"
      : false;
  const score = calculateSetupScore({
    direction: setup.direction,
    context,
    liquidity: setup.relatedLiquidity,
    sweep: setup.relatedSweep,
    displacement: setup.relatedDisplacement,
    structure: setup.relatedStructure,
    locationMatch,
    psychologyMatch,
    setupType: setup.type,
  });
  const reversalRisk = candleReading.reversalWarning.reversalRisk;

  return {
    ...setup,
    score: score.score,
    scoreBreakdown: score.breakdown,
    relatedHtfContext: `${context.htfBias.bias} ${context.htfBias.strength}/100 at confirmation`,
    relatedItfContext: `${context.itfSetup.setupState} ${context.itfSetup.strength}/100 at confirmation`,
    antiReversal: {
      reversalRisk,
      warnings: [...candleReading.reversalWarning.reasons],
      shouldAvoid: reversalRisk === "HIGH",
    },
  };
}

function hasLatestOppositeDisplacement(markers: MarketMarker[], direction: "BULLISH" | "BEARISH", confirmationIndex: number, triggerIndex: number): boolean {
  return markers.some((marker) => marker.type === "DISPLACEMENT" && marker.direction !== direction && marker.confirmedAtIndex >= triggerIndex && marker.confirmedAtIndex <= confirmationIndex);
}

function isExecutionWarning(warning: string): boolean {
  return /news|spread|slippage/i.test(warning);
}

function distanceToZone(price: number, setup: MarketSetup): number {
  if (price < setup.setupZone.minPrice) return setup.setupZone.minPrice - price;
  if (price > setup.setupZone.maxPrice) return price - setup.setupZone.maxPrice;
  return 0;
}

function confidenceFor(score: number): TradeSignal["confidence"] {
  if (score >= 90) return "PREMIUM";
  if (score >= 80) return "STRONG";
  if (score >= 70) return "MODERATE";
  return "LOW_CONFIRMED";
}

function strategyName(type: MarketSetup["type"]): string {
  return type.toLowerCase().split("_").map((part) => part[0] + part.slice(1).toLowerCase()).join(" ");
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function buildCacheKey(input: EntryEngineInput, candles: Candle[], settings: EntryEngineSettings): string {
  const last = candles.at(-1);
  return [input.symbol, input.timeframe, input.startDate, input.endDate, input.mode, candles.length, last?.timestamp ?? 0, input.setupScanner.audit.triggerCount, input.setupScanner.setups.map((setup) => `${setup.id}:${setup.state}:${setup.score}`).join("|"), JSON.stringify(settings)].join(":");
}

function cloneResult(result: EntryEngineResult, cacheStatus: "hit" | "miss"): EntryEngineResult {
  return { ...result, signalMap: new Map(result.signalMap), audit: { ...result.audit, cacheStatus } };
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function hasTriggerState(setup: MarketSetup): boolean {
  return setup.state === "TRIGGER" || setup.history.some((item) => item.to === "TRIGGER");
}

function triggerIndexFor(setup: MarketSetup): number | null {
  return setup.history.findLast((item) => item.to === "TRIGGER")?.candleIndex ?? (setup.state === "TRIGGER" ? setup.updatedAtIndex : null);
}

function toRejectedSetup(evaluation: SignalEvaluation): RejectedSetup {
  return {
    setupId: evaluation.setup.id,
    setupType: evaluation.setup.type,
    setupState: evaluation.setup.state,
    direction: evaluation.setup.direction,
    triggerIndex: triggerIndexFor(evaluation.setup),
    rejectionReasons: evaluation.rejectionReasons,
    rejectionReasonCodes: unique(evaluation.rejectionReasons.map(toRejectionCode)),
    debug: evaluation.debug,
  };
}

function dedupeSignals(signals: TradeSignal[]): TradeSignal[] {
  const signalMap = new Map<string, TradeSignal>();
  for (const signal of signals) {
    if (!signalMap.has(signal.id)) signalMap.set(signal.id, signal);
  }
  return [...signalMap.values()];
}

function countSetupStates(setups: MarketSetup[]): Record<MarketSetup["state"], number> {
  return setups.reduce<Record<MarketSetup["state"], number>>(
    (counts, setup) => ({ ...counts, [setup.state]: counts[setup.state] + 1 }),
    { WATCH: 0, SETUP: 0, TRIGGER: 0, INVALIDATED: 0, EXPIRED: 0 },
  );
}

function countTopReasons(reasons: string[], limit: number): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, limit);
}

function primaryFailureGroup(reasons: string[]): string {
  const text = reasons.join(" ").toLowerCase();
  if (text.includes("rr")) return "RR";
  if (text.includes("confirmation")) return "confirmation candle";
  if (text.includes("score")) return "score";
  if (text.includes("stop")) return "stop-loss";
  if (text.includes("target")) return "take-profit";
  return "entry filter";
}

function toRejectionCode(reason: string): SignalRejectionCode {
  const text = reason.toLowerCase();
  if (text.includes("waiting for confirmation")) return "CONFIRMATION_PENDING";
  if (text.includes("confirmation window expired") || text.includes("trigger expired")) return "CONFIRMATION_WINDOW_EXPIRED";
  if (text.includes("invalidated before confirmation")) return "INVALIDATED_BEFORE_CONFIRMATION";
  if (text.includes("future candle") || text.includes("future data")) return "DATA_NOT_ENOUGH";
  if (text.includes("not trigger") || text.includes("never reached")) return "SETUP_NOT_TRIGGER";
  if (text.includes("confirmation")) return "CONFIRMATION_CANDLE_MISSING";
  if (text.includes("score")) return "SCORE_TOO_LOW";
  if (text.includes("wait")) return "CONTEXT_WAIT";
  if (text.includes("htf") || text.includes("higher-timeframe")) return "HTF_OPPOSITE";
  if (text.includes("choppy")) return "MARKET_CHOPPY";
  if (text.includes("volatility")) return "VOLATILITY_BAD";
  if (text.includes("reversal")) return "REVERSAL_RISK_HIGH";
  if (text.includes("stop")) return "STOP_LOSS_INVALID";
  if (text.includes("target") || text.includes("take profit")) return "TAKE_PROFIT_NOT_FOUND";
  if (text.includes("rr") || text.includes("risk or reward")) return "RR_TOO_LOW";
  if (text.includes("extended") || text.includes("chase")) return "PRICE_TOO_EXTENDED";
  if (text.includes("session")) return "SESSION_LOW_QUALITY";
  if (text.includes("displacement")) return "NO_DISPLACEMENT";
  if (text.includes("mss") || text.includes("structure")) return "NO_MSS";
  return "DATA_NOT_ENOUGH";
}

function round(value: number, digits = 5): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
