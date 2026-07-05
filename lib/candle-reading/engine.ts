import type { Candle } from "@/lib/candles/types";

import type {
  CandleClassification,
  CandleDirection,
  CandleInterpretation,
  CandleReadingOptions,
  CandleReadingResult,
  CandleReadingScores,
  CandleSequenceReading,
  ConfidenceLabel,
  NextCandleScenarios,
  ReversalWarning,
  TraderQuestions,
} from "./types";

const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_ATR_PERIOD = 14;
const MAX_CACHE_ENTRIES = 100;
const readingCache = new Map<string, CandleReadingResult | null>();

export function analyzeCandleReading(
  inputCandles: Candle[],
  options: CandleReadingOptions = {},
): CandleReadingResult | null {
  const windowSize = clampInteger(options.windowSize ?? DEFAULT_WINDOW_SIZE, 15, 20);
  const atrPeriod = clampInteger(options.atrPeriod ?? DEFAULT_ATR_PERIOD, 2, 100);
  const source = sanitizeReadingWindow(inputCandles, windowSize + atrPeriod + 1);
  const cacheKey = buildReadingCacheKey(source, windowSize, atrPeriod);

  if (readingCache.has(cacheKey)) {
    return readingCache.get(cacheKey) ?? null;
  }

  if (source.length < 2) {
    rememberReading(cacheKey, null);
    return null;
  }

  const atr = calculateRollingAtr(source, atrPeriod);
  const startIndex = Math.max(0, source.length - windowSize);
  const analysisCandles = source.slice(startIndex);
  const volumeAverage = average(
    analysisCandles.filter((candle) => candle.volume > 0).map((candle) => candle.volume),
  );
  const readings = analysisCandles.map((candle, localIndex) => {
    const sourceIndex = startIndex + localIndex;
    return classifyCandle(
      candle,
      source[sourceIndex - 1],
      atr[sourceIndex],
      localIndex,
      analysisCandles.length,
      volumeAverage,
    );
  });
  const latest = readings.at(-1)!;
  const previous = readings.at(-2)!;
  const sequence = readCandleSequence(readings);
  const reversalWarning = buildReversalWarning(readings, sequence);
  const scores = scoreReading(readings, sequence, reversalWarning);
  const scenarios = buildNextCandleScenarios(
    readings,
    sequence,
    reversalWarning,
    scores.confidence.score,
  );
  const keyLevels = {
    previousHigh: previous.high,
    previousLow: previous.low,
    previousMidpoint: midpoint(previous.high, previous.low),
    latestClose: latest.close,
    bullishInvalidation: Math.min(previous.low, latest.low),
    bearishInvalidation: Math.max(previous.high, latest.high),
  };
  const questions = answerTraderQuestions(
    readings,
    sequence,
    reversalWarning,
    scenarios,
    keyLevels,
  );
  const humanSummary = buildHumanSummary(
    latest,
    sequence,
    reversalWarning,
    scenarios,
  );
  const result: CandleReadingResult = {
    analyzedCandleCount: readings.length,
    windowStartTimestamp: readings[0].timestamp,
    windowEndTimestamp: latest.timestamp,
    marketMood: sequence.shortTermFlow,
    latestCandle: latest,
    candles: readings,
    sequence,
    questions,
    scenarios,
    reversalWarning,
    scores,
    keyLevels,
    humanSummary,
  };

  rememberReading(cacheKey, result);
  return result;
}

export function classifyCandle(
  candle: Candle,
  previous: Candle | undefined,
  atrValue: number,
  index = 0,
  total = 1,
  averageVolume = 0,
): CandleInterpretation {
  const rangeSize = Math.max(0, candle.high - candle.low);
  const bodySize = Math.abs(candle.close - candle.open);
  const upperWick = Math.max(0, candle.high - Math.max(candle.open, candle.close));
  const lowerWick = Math.max(0, Math.min(candle.open, candle.close) - candle.low);
  const bodyRangeRatio = safeRatio(bodySize, rangeSize);
  const closePosition = safeRatio(candle.close - candle.low, rangeSize);
  const safeAtr = atrValue > 0 ? atrValue : rangeSize;
  const atrRatio = safeRatio(rangeSize, safeAtr);
  const direction: CandleDirection =
    bodyRangeRatio <= 0.08
      ? "NEUTRAL"
      : candle.close > candle.open
        ? "BULLISH"
        : "BEARISH";
  const classifications: CandleClassification[] = [];

  if (bodyRangeRatio <= 0.1) classifications.push("DOJI");
  if (bodyRangeRatio > 0.1 && bodyRangeRatio < 0.35) classifications.push("INDECISION");

  if (
    lowerWick >= Math.max(bodySize * 2, rangeSize * 0.45) &&
    upperWick <= rangeSize * 0.25 &&
    closePosition >= 0.58
  ) {
    classifications.push("PIN_BAR_BULLISH");
  }
  if (
    upperWick >= Math.max(bodySize * 2, rangeSize * 0.45) &&
    lowerWick <= rangeSize * 0.25 &&
    closePosition <= 0.42
  ) {
    classifications.push("PIN_BAR_BEARISH");
  }

  if (previous) {
    if (
      candle.close > candle.open &&
      previous.close < previous.open &&
      candle.open <= previous.close &&
      candle.close >= previous.open
    ) {
      classifications.push("ENGULFING_BULLISH");
    }
    if (
      candle.close < candle.open &&
      previous.close > previous.open &&
      candle.open >= previous.close &&
      candle.close <= previous.open
    ) {
      classifications.push("ENGULFING_BEARISH");
    }
    if (candle.high <= previous.high && candle.low >= previous.low) {
      classifications.push("INSIDE_BAR");
    }
    if (candle.high > previous.high && candle.low < previous.low) {
      classifications.push("OUTSIDE_BAR");
    }
  }

  if (atrRatio >= 1.3 && bodyRangeRatio >= 0.65) {
    classifications.push("DISPLACEMENT_CANDLE");
  }
  if (
    atrRatio >= 1.45 &&
    (bodyRangeRatio < 0.4 || upperWick >= rangeSize * 0.4 || lowerWick >= rangeSize * 0.4)
  ) {
    classifications.push("EXHAUSTION_CANDLE");
  }

  if (direction === "BULLISH") {
    classifications.push(
      bodyRangeRatio >= 0.62 && closePosition >= 0.72
        ? "STRONG_BULLISH"
        : "WEAK_BULLISH",
    );
  } else if (direction === "BEARISH") {
    classifications.push(
      bodyRangeRatio >= 0.62 && closePosition <= 0.28
        ? "STRONG_BEARISH"
        : "WEAK_BEARISH",
    );
  } else if (!classifications.includes("DOJI")) {
    classifications.push("INDECISION");
  }

  const primaryType = selectPrimaryClassification(classifications);
  const control = readControl(direction, closePosition, bodyRangeRatio);
  const closeStrength = readCloseStrength(direction, closePosition, bodyRangeRatio);
  const rejection = readRejection(upperWick, lowerWick, rangeSize);
  const relationToPrevious = describePreviousRelation(candle, previous);
  const volumeContext = describeVolume(candle.volume, averageVolume);

  return {
    index,
    sequenceNumber: index + 1,
    timestamp: candle.timestamp,
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    bodySize,
    rangeSize,
    upperWick,
    lowerWick,
    closePosition,
    bodyRangeRatio,
    atr: safeAtr,
    atrRatio,
    direction,
    primaryType,
    classifications: [...new Set(classifications)],
    control,
    closeStrength,
    rejection,
    relationToPrevious,
    volumeContext,
    explanation: buildCandleExplanation({
      sequenceNumber: index + 1,
      total,
      direction,
      control,
      closeStrength,
      rejection,
      bodyRangeRatio,
      relationToPrevious,
    }),
  };
}

export function clearCandleReadingCache(): void {
  readingCache.clear();
}

function sanitizeReadingWindow(candles: Candle[], limit: number): Candle[] {
  const now = Date.now();
  const candidates = candles.slice(-Math.max(limit * 2, limit));
  const byTimestamp = new Map<number, Candle>();

  for (const candle of candidates) {
    if (
      !candle.isClosed ||
      !Number.isFinite(candle.timestamp) ||
      candle.timestamp > now ||
      (typeof candle.closeTime === "number" && candle.closeTime > now) ||
      ![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) ||
      candle.high < Math.max(candle.open, candle.close) ||
      candle.low > Math.min(candle.open, candle.close) ||
      candle.high <= candle.low
    ) {
      continue;
    }

    byTimestamp.set(candle.timestamp, candle);
  }

  return [...byTimestamp.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-limit);
}

function calculateRollingAtr(candles: Candle[], period: number): number[] {
  const output: number[] = [];
  const trueRanges: number[] = [];
  let rollingSum = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1]?.close ?? candle.open;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
    trueRanges.push(trueRange);
    rollingSum += trueRange;

    if (index >= period) rollingSum -= trueRanges[index - period];
    output.push(rollingSum / Math.min(index + 1, period));
  }

  return output;
}

function readCandleSequence(readings: CandleInterpretation[]): CandleSequenceReading {
  let higherHighs = 0;
  let higherLows = 0;
  let lowerHighs = 0;
  let lowerLows = 0;
  let bullishPressure = 0;
  let bearishPressure = 0;

  for (let index = 0; index < readings.length; index += 1) {
    const candle = readings[index];
    const previous = readings[index - 1];
    if (previous) {
      if (candle.high > previous.high) higherHighs += 1;
      if (candle.low > previous.low) higherLows += 1;
      if (candle.high < previous.high) lowerHighs += 1;
      if (candle.low < previous.low) lowerLows += 1;
    }
    if (candle.control === "BUYERS") bullishPressure += 1 + candle.bodyRangeRatio;
    if (candle.control === "SELLERS") bearishPressure += 1 + candle.bodyRangeRatio;
  }

  const bullishStructure = higherHighs + higherLows;
  const bearishStructure = lowerHighs + lowerLows;
  const directionalDifference = Math.abs(bullishStructure - bearishStructure);
  const shortTermFlow =
    bullishStructure >= bearishStructure * 1.25 && higherLows >= lowerLows
      ? "BULLISH"
      : bearishStructure >= bullishStructure * 1.25 && lowerHighs >= higherHighs
        ? "BEARISH"
        : directionalDifference <= 2
          ? "RANGING"
          : "CHOPPY";

  const recent = readings.slice(-5);
  const prior = readings.slice(-10, -5);
  const recentRange = average(recent.map((candle) => candle.rangeSize));
  const priorRange = average(prior.map((candle) => candle.rangeSize)) || recentRange;
  const volatilityState =
    recentRange > priorRange * 1.2
      ? "EXPANDING"
      : recentRange < priorRange * 0.8
        ? "CONTRACTING"
        : "NORMAL";
  const recentBody = average(recent.map((candle) => candle.bodyRangeRatio));
  const priorBody = average(prior.map((candle) => candle.bodyRangeRatio)) || recentBody;
  const latest = readings.at(-1)!;
  const momentumState =
    latest.classifications.includes("EXHAUSTION_CANDLE") ||
    (latest.primaryType === "DOJI" && priorBody > 0.55)
      ? "EXHAUSTED"
      : recentBody > priorBody * 1.18
        ? "INCREASING"
        : recentBody < priorBody * 0.82
          ? "DECREASING"
          : "NEUTRAL";
  const pressure =
    bullishPressure > bearishPressure * 1.2
      ? "BUYERS_ACTIVE"
      : bearishPressure > bullishPressure * 1.2
        ? "SELLERS_ACTIVE"
        : "BALANCED";
  const features = detectSequenceFeatures(
    readings,
    shortTermFlow,
    volatilityState,
    momentumState,
  );

  return {
    shortTermFlow,
    momentumState,
    volatilityState,
    pressure,
    features,
    reason: `${shortTermFlow.toLowerCase()} flow from ${higherHighs} higher highs, ${higherLows} higher lows, ${lowerHighs} lower highs, and ${lowerLows} lower lows; momentum is ${momentumState.toLowerCase()} with ${volatilityState.toLowerCase()} volatility.`,
  };
}

function detectSequenceFeatures(
  readings: CandleInterpretation[],
  flow: CandleSequenceReading["shortTermFlow"],
  volatility: CandleSequenceReading["volatilityState"],
  momentum: CandleSequenceReading["momentumState"],
): string[] {
  const features = new Set<string>();
  if (flow === "RANGING") features.add("range behavior");
  if (volatility === "CONTRACTING") features.add("compression");
  if (volatility === "EXPANDING") features.add("expansion");
  if (momentum === "DECREASING") features.add("momentum loss");
  if (momentum === "EXHAUSTED") features.add("exhaustion");

  const latest = readings.at(-1)!;
  const lookback = readings.slice(-6, -1);
  if (lookback.length > 0) {
    const priorHigh = Math.max(...lookback.map((candle) => candle.high));
    const priorLow = Math.min(...lookback.map((candle) => candle.low));
    if (latest.high > priorHigh && latest.close < priorHigh) {
      features.add("failed bullish breakout");
      features.add("high-side liquidity grab");
    }
    if (latest.low < priorLow && latest.close > priorLow) {
      features.add("failed bearish breakout");
      features.add("low-side liquidity grab");
    }
  }
  if (readings.slice(-3).every((candle) => candle.direction === latest.direction)) {
    features.add("trend continuation");
  }
  const priorThree = readings.slice(-4, -1);
  if (
    priorThree.length === 3 &&
    priorThree.every((candle) => candle.direction === "BULLISH") &&
    latest.direction === "BEARISH" &&
    latest.close < midpoint(readings.at(-2)!.high, readings.at(-2)!.low)
  ) {
    features.add("bearish reversal attempt");
  }
  if (
    priorThree.length === 3 &&
    priorThree.every((candle) => candle.direction === "BEARISH") &&
    latest.direction === "BULLISH" &&
    latest.close > midpoint(readings.at(-2)!.high, readings.at(-2)!.low)
  ) {
    features.add("bullish reversal attempt");
  }
  if (readings.slice(-3).filter((candle) => candle.bodyRangeRatio < 0.3).length >= 2) {
    features.add("absorption or indecision");
  }
  if (features.size === 0) features.add("orderly two-way trade");
  return [...features];
}

function buildReversalWarning(
  readings: CandleInterpretation[],
  sequence: CandleSequenceReading,
): ReversalWarning {
  const reasons: string[] = [];
  const latest = readings.at(-1)!;
  const previous = readings.at(-2)!;
  const recent = readings.slice(-4);
  const windowHigh = Math.max(...readings.map((candle) => candle.high));
  const windowLow = Math.min(...readings.map((candle) => candle.low));
  const windowRange = windowHigh - windowLow;
  const priorVolumeAverage = average(
    readings
      .slice(-6, -1)
      .filter((candle) => candle.volume > 0)
      .map((candle) => candle.volume),
  );
  const sameDirection = recent.filter(
    (candle) => candle.direction === latest.direction,
  ).length;

  if (latest.atrRatio >= 1.5) reasons.push("Latest candle is extended versus ATR.");
  if (sameDirection >= 3 && latest.atrRatio >= 1.1) {
    reasons.push("Price is extended after several candles in one direction.");
  }
  if (
    windowRange > 0 &&
    latest.direction === "BULLISH" &&
    latest.close >= windowLow + windowRange * 0.75
  ) {
    reasons.push("Bullish pressure is closing in the premium quarter of the reading range.");
  }
  if (
    windowRange > 0 &&
    latest.direction === "BEARISH" &&
    latest.close <= windowLow + windowRange * 0.25
  ) {
    reasons.push("Bearish pressure is closing in the discount quarter of the reading range.");
  }
  if (latest.direction === "BULLISH" && latest.upperWick > latest.bodySize) {
    reasons.push("Upper-wick rejection opposed the bullish close.");
  }
  if (latest.direction === "BEARISH" && latest.lowerWick > latest.bodySize) {
    reasons.push("Lower-wick rejection opposed the bearish close.");
  }
  if (latest.classifications.includes("DOJI") && previous.bodyRangeRatio >= 0.6) {
    reasons.push("A doji followed a strong directional candle.");
  }
  if (latest.classifications.includes("EXHAUSTION_CANDLE")) {
    reasons.push("Expanded range finished with exhaustion characteristics.");
  }
  if (sequence.momentumState === "DECREASING" || sequence.momentumState === "EXHAUSTED") {
    reasons.push("Sequence momentum is fading.");
  }
  if (sequence.features.some((feature) => feature.includes("failed"))) {
    reasons.push("The latest breakout failed back inside the prior range.");
  }
  if (
    previous.classifications.includes("DISPLACEMENT_CANDLE") &&
    latest.direction !== previous.direction &&
    latest.closeStrength !== "STRONG"
  ) {
    reasons.push("Displacement did not receive clean follow-through.");
  }
  if (
    latest.volume > 0 &&
    priorVolumeAverage > 0 &&
    latest.atrRatio >= 1.2 &&
    latest.volume < priorVolumeAverage * 0.75
  ) {
    reasons.push("Range expanded while reported volume fell below its recent average.");
  }

  const reversalRisk = reasons.length >= 3 ? "HIGH" : reasons.length >= 1 ? "MEDIUM" : "LOW";
  return {
    reversalRisk,
    reasons,
    avoidChasing: reversalRisk === "HIGH" || latest.atrRatio >= 1.5,
  };
}

function scoreReading(
  readings: CandleInterpretation[],
  sequence: CandleSequenceReading,
  reversal: ReversalWarning,
): CandleReadingScores {
  const latest = readings.at(-1)!;
  const previous = readings.at(-2)!;
  const bodyStrength = latest.bodyRangeRatio >= 0.65 ? 2 : latest.bodyRangeRatio >= 0.35 ? 1 : 0;
  const closePosition =
    (latest.direction === "BULLISH" && latest.closePosition >= 0.75) ||
    (latest.direction === "BEARISH" && latest.closePosition <= 0.25)
      ? 2
      : latest.closeStrength === "WEAK"
        ? 0
        : 1;
  const wickRejection = latest.rejection === "NONE" ? 2 : latest.rejection === "BOTH" ? 0 : 1;
  const atrExpansion = latest.atrRatio >= 1.2 ? 2 : latest.atrRatio >= 0.8 ? 1 : 0;
  const followThrough = latest.direction === previous.direction ? 2 : latest.direction === "NEUTRAL" ? 0 : 1;
  const latestComponents = {
    bodyStrength,
    closePosition,
    wickRejection,
    atrExpansion,
    followThroughContext: followThrough,
  };
  const latestTotal = sumValues(latestComponents);

  const trendClarity = sequence.shortTermFlow === "BULLISH" || sequence.shortTermFlow === "BEARISH" ? 2 : sequence.shortTermFlow === "RANGING" ? 1 : 0;
  const momentumConsistency = sequence.momentumState === "INCREASING" ? 2 : sequence.momentumState === "NEUTRAL" ? 1 : 0;
  const liquidityContext = sequence.features.some((feature) => feature.includes("liquidity")) ? 2 : 1;
  const compressionExpansionQuality = sequence.volatilityState === "NORMAL" ? 1 : 2;
  const reversalRisk = reversal.reversalRisk === "LOW" ? 2 : reversal.reversalRisk === "MEDIUM" ? 1 : 0;
  const sequenceComponents = {
    trendClarity,
    momentumConsistency,
    liquidityContext,
    compressionExpansionQuality,
    reversalRisk,
  };
  const sequenceTotal = sumValues(sequenceComponents);
  const confidenceScore = Math.round((latestTotal + sequenceTotal) / 2);

  return {
    latestCandle: {
      total: latestTotal,
      label: confidenceLabel(latestTotal),
      components: latestComponents,
    },
    sequence: {
      total: sequenceTotal,
      label: confidenceLabel(sequenceTotal),
      components: sequenceComponents,
    },
    confidence: {
      score: confidenceScore,
      label: confidenceLabel(confidenceScore),
    },
  };
}

function buildNextCandleScenarios(
  readings: CandleInterpretation[],
  sequence: CandleSequenceReading,
  reversal: ReversalWarning,
  confidence: number,
): NextCandleScenarios {
  const latest = readings.at(-1)!;
  const previous = readings.at(-2)!;
  const midpointLevel = midpoint(latest.high, latest.low);
  let bullish = 33;
  let bearish = 33;
  let neutral = 34;

  if (sequence.shortTermFlow === "BULLISH") bullish += 12;
  if (sequence.shortTermFlow === "BEARISH") bearish += 12;
  if (sequence.shortTermFlow === "RANGING") neutral += 10;
  if (sequence.pressure === "BUYERS_ACTIVE") bullish += 8;
  if (sequence.pressure === "SELLERS_ACTIVE") bearish += 8;
  if (latest.closeStrength === "STRONG" && latest.direction === "BULLISH") bullish += 6;
  if (latest.closeStrength === "STRONG" && latest.direction === "BEARISH") bearish += 6;
  if (sequence.volatilityState === "CONTRACTING") neutral += 6;
  if (reversal.reversalRisk === "HIGH") {
    if (latest.direction === "BULLISH") bearish += 7;
    if (latest.direction === "BEARISH") bullish += 7;
    neutral += 4;
  }

  [bullish, bearish, neutral] = normalizeProbabilities(bullish, bearish, neutral);
  const expectedBias =
    bullish >= bearish + 6 && bullish >= neutral + 4
      ? "BULLISH"
      : bearish >= bullish + 6 && bearish >= neutral + 4
        ? "BEARISH"
        : "NEUTRAL";

  return {
    expectedBias,
    bullishScenario: {
      probability: bullish,
      condition: `Hold above ${formatPrice(midpointLevel)} and close through ${formatPrice(latest.high)} with a firm body.`,
      expectedBehavior: "Continuation toward nearby highs is more plausible if the breakout holds on a closed candle.",
      invalidation: Math.min(latest.low, previous.low),
    },
    bearishScenario: {
      probability: bearish,
      condition: `Reject above ${formatPrice(latest.high)} or close below ${formatPrice(midpointLevel)} and then ${formatPrice(latest.low)}.`,
      expectedBehavior: "A pullback or bearish continuation becomes more plausible after a decisive closed-candle failure.",
      invalidation: Math.max(latest.high, previous.high),
    },
    neutralScenario: {
      probability: neutral,
      condition: `Remain inside ${formatPrice(latest.low)} - ${formatPrice(latest.high)} without a strong close beyond either edge.`,
      expectedBehavior: "Two-way trade, compression, or a range rotation remains the cleaner interpretation.",
      invalidation: expectedBias === "BEARISH" ? latest.high : latest.low,
    },
    confidence,
    warning: reversal.avoidChasing
      ? "Extension or rejection risk is elevated. Wait for a closed-candle condition; this is scenario analysis, not a trade signal."
      : "Probabilities describe conditional paths from closed candles and are not a guaranteed prediction or trade signal.",
  };
}

function answerTraderQuestions(
  readings: CandleInterpretation[],
  sequence: CandleSequenceReading,
  reversal: ReversalWarning,
  scenarios: NextCandleScenarios,
  levels: CandleReadingResult["keyLevels"],
): TraderQuestions {
  const latest = readings.at(-1)!;
  const failedBreakout = sequence.features.find((feature) => feature.includes("failed"));
  const sweep = sequence.features.find((feature) => feature.includes("liquidity grab"));
  return {
    lastCandleControl: latest.control === "BALANCED" ? "Control was balanced." : `${titleCase(latest.control)} controlled the latest close.`,
    closeQuality: `The latest candle closed ${latest.closeStrength.toLowerCase()} with a ${Math.round(latest.bodyRangeRatio * 100)}% body-to-range ratio.`,
    rejection: latest.rejection === "NONE" ? "No dominant wick rejection." : `Price rejected the ${latest.rejection.toLowerCase()} side of the candle.`,
    volatility: `Price is ${sequence.volatilityState.toLowerCase()} relative to the preceding candle group.`,
    momentum: `Momentum is ${sequence.momentumState.toLowerCase()}.`,
    breakoutTrap: failedBreakout ? `Possible trap: ${failedBreakout}.` : "No closed-candle breakout trap is confirmed.",
    liquiditySweep: sweep ? `Possible ${sweep}.` : "No local five-candle liquidity grab is confirmed.",
    extensionRisk: reversal.avoidChasing ? "Price is too extended or conflicted to chase without confirmation." : "No exceptional extension warning from the latest candle.",
    nextCandleExpectation: `${scenarios.expectedBias.toLowerCase()} is the leading conditional bias; continuation, reversal, and range paths remain open.`,
    bullishConfirmation: `A strong candle close above ${formatPrice(levels.previousHigh)} supports bullish continuation.`,
    bearishConfirmation: `A strong candle close below ${formatPrice(levels.previousLow)} supports bearish continuation.`,
    currentReadInvalidation: `A close beyond the opposite boundary (${formatPrice(levels.bullishInvalidation)} / ${formatPrice(levels.bearishInvalidation)}) invalidates the matching directional read.`,
  };
}

function buildHumanSummary(
  latest: CandleInterpretation,
  sequence: CandleSequenceReading,
  reversal: ReversalWarning,
  scenarios: NextCandleScenarios,
): string {
  const riskText =
    reversal.reversalRisk === "LOW"
      ? "Immediate reversal evidence is limited."
      : `Immediate reversal risk is ${reversal.reversalRisk.toLowerCase()}, so chasing the latest move needs more confirmation.`;
  return `${latest.explanation} Across the reading window, flow is ${sequence.shortTermFlow.toLowerCase()}, ${sequence.pressure.toLowerCase().replace("_", " ")}, and momentum is ${sequence.momentumState.toLowerCase()}. The next closed candle has a conditional ${scenarios.expectedBias.toLowerCase()} bias. ${riskText}`;
}

function buildCandleExplanation(input: {
  sequenceNumber: number;
  total: number;
  direction: CandleDirection;
  control: CandleInterpretation["control"];
  closeStrength: CandleInterpretation["closeStrength"];
  rejection: CandleInterpretation["rejection"];
  bodyRangeRatio: number;
  relationToPrevious: string;
}): string {
  const direction = input.direction.toLowerCase();
  const control = input.control === "BALANCED" ? "neither side controlled" : `${input.control.toLowerCase()} controlled`;
  const wickText = input.rejection === "NONE" ? "no dominant wick rejection" : `${input.rejection.toLowerCase()}-side rejection`;
  return `Candle ${input.sequenceNumber} of ${input.total} closed ${direction} with a ${Math.round(input.bodyRangeRatio * 100)}% body, a ${input.closeStrength.toLowerCase()} close, and ${wickText}; ${control} the finish. ${input.relationToPrevious}`;
}

function describePreviousRelation(candle: Candle, previous?: Candle): string {
  if (!previous) return "It starts the current reading window.";
  if (candle.high <= previous.high && candle.low >= previous.low) return "It remained inside the previous candle range.";
  if (candle.high > previous.high && candle.low < previous.low) return "It expanded outside both sides of the previous candle.";
  if (candle.close > previous.high) return "It closed above the previous high.";
  if (candle.close < previous.low) return "It closed below the previous low.";
  if (candle.high > previous.high) return "It traded above the previous high but closed back within the broader range.";
  if (candle.low < previous.low) return "It traded below the previous low but closed back within the broader range.";
  return "It overlapped the previous candle without a range break.";
}

function describeVolume(volume: number, volumeAverage: number): string {
  if (volume <= 0 || volumeAverage <= 0) return "Volume unavailable";
  if (volume >= volumeAverage * 1.35) return "Volume above recent average";
  if (volume <= volumeAverage * 0.65) return "Volume below recent average";
  return "Volume near recent average";
}

function selectPrimaryClassification(types: CandleClassification[]): CandleClassification {
  const priority: CandleClassification[] = [
    "ENGULFING_BULLISH",
    "ENGULFING_BEARISH",
    "PIN_BAR_BULLISH",
    "PIN_BAR_BEARISH",
    "DOJI",
    "OUTSIDE_BAR",
    "INSIDE_BAR",
    "EXHAUSTION_CANDLE",
    "DISPLACEMENT_CANDLE",
    "STRONG_BULLISH",
    "STRONG_BEARISH",
    "INDECISION",
    "WEAK_BULLISH",
    "WEAK_BEARISH",
  ];
  return priority.find((type) => types.includes(type)) ?? "INDECISION";
}

function readControl(
  direction: CandleDirection,
  closePosition: number,
  bodyRatio: number,
): CandleInterpretation["control"] {
  if (direction === "BULLISH" && closePosition >= 0.6 && bodyRatio >= 0.3) return "BUYERS";
  if (direction === "BEARISH" && closePosition <= 0.4 && bodyRatio >= 0.3) return "SELLERS";
  return "BALANCED";
}

function readCloseStrength(
  direction: CandleDirection,
  closePosition: number,
  bodyRatio: number,
): CandleInterpretation["closeStrength"] {
  if (bodyRatio < 0.25 || direction === "NEUTRAL") return "WEAK";
  if (
    (direction === "BULLISH" && closePosition >= 0.72) ||
    (direction === "BEARISH" && closePosition <= 0.28)
  ) return "STRONG";
  return "NEUTRAL";
}

function readRejection(
  upperWick: number,
  lowerWick: number,
  range: number,
): CandleInterpretation["rejection"] {
  const upper = upperWick >= range * 0.32;
  const lower = lowerWick >= range * 0.32;
  if (upper && lower) return "BOTH";
  if (upper) return "HIGH";
  if (lower) return "LOW";
  return "NONE";
}

function normalizeProbabilities(a: number, b: number, c: number): [number, number, number] {
  const total = a + b + c;
  const first = Math.round((a / total) * 100);
  const second = Math.round((b / total) * 100);
  return [first, second, 100 - first - second];
}

function buildReadingCacheKey(candles: Candle[], windowSize: number, atrPeriod: number): string {
  const latest = candles.at(-1);
  let fingerprint = 0;
  for (const candle of candles) {
    fingerprint = (fingerprint * 31 + candle.timestamp) >>> 0;
    fingerprint = (fingerprint * 31 + Math.round(candle.open * 1000)) >>> 0;
    fingerprint = (fingerprint * 31 + Math.round(candle.high * 1000)) >>> 0;
    fingerprint = (fingerprint * 31 + Math.round(candle.low * 1000)) >>> 0;
    fingerprint = (fingerprint * 31 + Math.round(candle.close * 1000)) >>> 0;
    fingerprint = (fingerprint * 31 + Math.round(candle.volume)) >>> 0;
  }
  return `${latest?.timestamp ?? "empty"}:${candles.length}:${windowSize}:${atrPeriod}:${fingerprint.toString(36)}`;
}

function rememberReading(key: string, result: CandleReadingResult | null): void {
  if (readingCache.size >= MAX_CACHE_ENTRIES) {
    readingCache.delete(readingCache.keys().next().value ?? "");
  }
  readingCache.set(key, result);
}

function confidenceLabel(score: number): ConfidenceLabel {
  if (score <= 3) return "LOW";
  if (score <= 6) return "MEDIUM";
  if (score <= 8) return "GOOD";
  return "STRONG";
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function midpoint(high: number, low: number): number {
  return low + (high - low) / 2;
}

function safeRatio(value: number, denominator: number): number {
  return denominator > 0 ? value / denominator : 0;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sumValues(values: Record<string, number>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 5 }).format(value);
}
