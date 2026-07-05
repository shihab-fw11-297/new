import { analyzeCandleReading } from "../candle-reading/engine";
import type { Candle } from "../candles/types";
import {
  calculateMarketStructure,
  calculateRollingAtr,
} from "../market-structure/engine";
import type {
  MarketStructureResult,
  StructureMarker,
  SweepMarker,
} from "../market-structure/types";

import {
  aggregateCandles,
  getTimeframeMapping,
} from "./timeframes";
import type {
  ContextScore,
  HtfBias,
  ItfEvidence,
  ItfSetupContext,
  KeyLevel,
  MarketContextInput,
  MarketContextResult,
  MarketRegime,
  NearestLevels,
  PremiumDiscountContext,
  RegimeMetrics,
  SessionContext,
  TradingSession,
  VolatilityContext,
  WaitContext,
} from "./types";

const contextCache = new Map<string, MarketContextResult>();

export function calculateMarketContext(input: MarketContextInput): MarketContextResult {
  const candles = input.candles.filter((candle) => candle.isClosed);
  const key = buildContextKey(input, candles);
  const cached = contextCache.get(key);
  if (cached) return { ...cached, cacheStatus: "hit" };

  const mapping = getTimeframeMapping(input.timeframe);
  const namespace = `${input.symbol}:${input.timeframe}:${input.startDate}:${input.endDate}`;
  const itfCandles = aggregateCandles(candles, mapping.ltf, mapping.itf, namespace);
  const htfCandles = aggregateCandles(candles, mapping.ltf, mapping.htf, namespace);
  const ltfStructure = structureFor(input, candles, "ltf");
  const itfStructure = structureFor(input, itfCandles, "itf");
  const htfStructure = structureFor(input, htfCandles, "htf");
  const htfBias = calculateHtfBias(htfCandles, htfStructure);
  const premiumDiscount = calculatePremiumDiscount(
    htfBias.majorSwingHigh,
    htfBias.majorSwingLow,
    candles.at(-1)?.close ?? null,
  );
  const itfSetup = calculateItfSetup(itfCandles, itfStructure);
  const volatility = calculateVolatility(candles, input.marketStructureSettings.atrPeriod);
  const reading = analyzeCandleReading(candles, {
    windowSize: 20,
    atrPeriod: input.marketStructureSettings.atrPeriod,
  });
  const regime = calculateRegime(candles, ltfStructure, volatility, reading);
  const session = calculateSessionContext(candles, input.displayTimezone);
  const levels = buildKeyLevels({
    candles,
    ltfStructure,
    itfStructure,
    htfStructure,
    session,
  });
  const nearestLevels = findNearestLevels(levels, candles.at(-1)?.close ?? 0);
  const wait = buildWaitContext({ htfBias, itfSetup, premiumDiscount, regime, session, volatility, nearestLevels });
  const score = calculateContextScore({ htfBias, itfSetup, premiumDiscount, regime, session, volatility, nearestLevels, wait });

  const result: MarketContextResult = {
    mapping,
    itfCandles,
    htfCandles,
    htfBias,
    itfSetup,
    premiumDiscount,
    levels,
    nearestLevels,
    regime,
    session,
    volatility,
    score,
    wait,
    cacheStatus: "miss",
  };
  if (contextCache.size >= 50) contextCache.delete(contextCache.keys().next().value ?? "");
  contextCache.set(key, result);
  return result;
}

export function calculateHtfBias(
  candles: Candle[],
  structure: MarketStructureResult,
): HtfBias {
  if (candles.length < 3) {
    return {
      bias: "UNKNOWN",
      strength: 0,
      structureState: "UNKNOWN",
      lastBos: null,
      lastChoch: null,
      majorSwingHigh: null,
      majorSwingLow: null,
      reason: "Not enough completed higher-timeframe candles.",
      warnings: ["Higher-timeframe history is incomplete."],
    };
  }

  const recent = candles.slice(-20);
  let higherHighs = 0;
  let higherLows = 0;
  let lowerHighs = 0;
  let lowerLows = 0;
  for (let index = 1; index < recent.length; index += 1) {
    if (recent[index].high > recent[index - 1].high) higherHighs += 1;
    if (recent[index].low > recent[index - 1].low) higherLows += 1;
    if (recent[index].high < recent[index - 1].high) lowerHighs += 1;
    if (recent[index].low < recent[index - 1].low) lowerLows += 1;
  }
  const structures = structure.markers.filter(
    (marker): marker is StructureMarker => marker.type === "BOS" || marker.type === "CHOCH" || marker.type === "MSS",
  );
  const lastBos = structures.findLast((marker) => marker.type === "BOS") ?? null;
  const lastChoch = structures.findLast((marker) => marker.type === "CHOCH") ?? null;
  const lastBreak = structures.at(-1);
  const displacements = structure.markers.filter(
    (marker) => marker.type === "DISPLACEMENT",
  );
  const lastDisplacement = displacements.at(-1);
  const sweeps = structure.markers.filter(
    (marker): marker is SweepMarker => marker.type === "SSL_SWEEP" || marker.type === "BSL_SWEEP",
  );
  const lastSweep = sweeps.at(-1);
  const swingHighs = structure.markers.filter((marker) => marker.type === "SWING_HIGH");
  const swingLows = structure.markers.filter((marker) => marker.type === "SWING_LOW");
  const majorSwingHigh = swingHighs.at(-1)?.price ?? Math.max(...recent.map((candle) => candle.high));
  const majorSwingLow = swingLows.at(-1)?.price ?? Math.min(...recent.map((candle) => candle.low));
  const location = calculatePremiumDiscount(majorSwingHigh, majorSwingLow, recent.at(-1)!.close);

  let bullish = 0;
  let bearish = 0;
  if (higherHighs > lowerHighs && higherLows > lowerLows) bullish += 25;
  if (lowerHighs > higherHighs && lowerLows > higherLows) bearish += 25;
  if (lastBreak?.direction === "BULLISH") bullish += lastBreak.type === "BOS" ? 20 : 15;
  if (lastBreak?.direction === "BEARISH") bearish += lastBreak.type === "BOS" ? 20 : 15;
  if (lastDisplacement?.direction === "BULLISH") bullish += 20;
  if (lastDisplacement?.direction === "BEARISH") bearish += 20;
  if (location?.zone === "DISCOUNT" || location?.zone === "DEEP_DISCOUNT") bullish += 15;
  if (location?.zone === "PREMIUM" || location?.zone === "DEEP_PREMIUM") bearish += 15;
  if (lastSweep?.type === "SSL_SWEEP") bullish += 10;
  if (lastSweep?.type === "BSL_SWEEP") bearish += 10;
  const atr = calculateRollingAtr(recent, Math.min(14, recent.length));
  const volatilityRatio = safeRatio(atr.at(-1) ?? 0, average(atr));
  const volatilityQuality = volatilityRatio >= 0.7 && volatilityRatio <= 1.7 ? 10 : 3;
  bullish += volatilityQuality;
  bearish += volatilityQuality;

  const difference = Math.abs(bullish - bearish);
  const bias =
    bullish >= bearish + 15
      ? "BULLISH"
      : bearish >= bullish + 15
        ? "BEARISH"
        : higherHighs + lowerLows <= Math.max(2, recent.length / 3)
          ? "RANGING"
          : "NEUTRAL";
  const strength = bias === "BULLISH" ? bullish : bias === "BEARISH" ? bearish : Math.max(20, 60 - difference);
  const warnings: string[] = [];
  if (bias === "NEUTRAL" || bias === "RANGING") warnings.push("Higher-timeframe direction is not clean.");
  if (location?.zone === "EQUILIBRIUM") warnings.push("Price is near dealing-range equilibrium.");

  return {
    bias,
    strength: clamp(strength, 0, 100),
    structureState: structure.audit.currentStructureState,
    lastBos: lastBos?.id ?? null,
    lastChoch: lastChoch?.id ?? null,
    majorSwingHigh,
    majorSwingLow,
    reason: `${bias.toLowerCase()} HTF context: HH/HL ${higherHighs}/${higherLows}, LH/LL ${lowerHighs}/${lowerLows}, latest structure ${lastBreak?.type ?? "none"}, and latest displacement ${lastDisplacement?.direction?.toLowerCase() ?? "none"}.`,
    warnings,
  };
}

export function evaluateItfSetup(evidence: ItfEvidence): ItfSetupContext {
  const setupState = evidence.invalidated
    ? "INVALIDATED"
    : evidence.sweepId && evidence.displacementId && evidence.structureId && evidence.pullbackZone
      ? "READY_FOR_LTF_TRIGGER"
      : evidence.pullbackZone
        ? "PULLBACK_FORMING"
        : evidence.structureId
          ? "MSS_CONFIRMED"
          : evidence.displacementId
            ? "DISPLACEMENT_CONFIRMED"
            : evidence.sweepId
              ? "SWEEP_CONFIRMED"
              : evidence.sweepProximity
                ? "SWEEP_FORMING"
                : evidence.liquidityId
                  ? "LIQUIDITY_BUILDING"
                  : "NO_SETUP";
  const strengths: Record<ItfSetupContext["setupState"], number> = {
    NO_SETUP: 5,
    LIQUIDITY_BUILDING: 20,
    SWEEP_FORMING: 35,
    SWEEP_CONFIRMED: 50,
    DISPLACEMENT_CONFIRMED: 62,
    MSS_CONFIRMED: 75,
    PULLBACK_FORMING: 82,
    READY_FOR_LTF_TRIGGER: 92,
    INVALIDATED: 0,
  };
  return {
    setupState,
    direction: evidence.direction,
    strength: strengths[setupState],
    relatedLiquidity: evidence.liquidityId ?? null,
    relatedSweep: evidence.sweepId ?? null,
    relatedDisplacement: evidence.displacementId ?? null,
    relatedStructure: evidence.structureId ?? null,
    pullbackZone: evidence.pullbackZone ?? null,
    reason: `${setupState.toLowerCase().replaceAll("_", " ")} from confirmed intermediate-timeframe evidence. This describes environment only.`,
    invalidation: evidence.invalidation ?? null,
  };
}

export function calculatePremiumDiscount(
  rangeHigh: number | null,
  rangeLow: number | null,
  currentPrice: number | null,
): PremiumDiscountContext | null {
  if (rangeHigh === null || rangeLow === null || currentPrice === null || rangeHigh <= rangeLow) return null;
  const percent = clamp(((currentPrice - rangeLow) / (rangeHigh - rangeLow)) * 100, 0, 100);
  const zone = percent >= 75
    ? "DEEP_PREMIUM"
    : percent > 55
      ? "PREMIUM"
      : percent >= 45
        ? "EQUILIBRIUM"
        : percent > 25
          ? "DISCOUNT"
          : "DEEP_DISCOUNT";
  const buyQuality = Math.round(100 - percent);
  const sellQuality = Math.round(percent);
  return {
    rangeHigh,
    rangeLow,
    equilibrium: rangeLow + (rangeHigh - rangeLow) / 2,
    currentPositionPercent: percent,
    zone,
    buyQuality,
    sellQuality,
    reason: `Price is ${percent.toFixed(1)}% through the confirmed dealing range, placing it in ${zone.toLowerCase().replaceAll("_", " ")}. This is context quality, not an entry.`,
  };
}

export function scoreKeyLevel(input: {
  timeframe: KeyLevel["timeframe"];
  type: KeyLevel["type"];
  touchedCount: number;
  swept: boolean;
  ageBars: number;
}): number {
  const timeframeScore = input.timeframe === "HTF" ? 35 : input.timeframe === "ITF" ? 25 : 15;
  const typeScore = input.type.startsWith("MAJOR_SWING") ? 25 : input.type === "BSL" || input.type === "SSL" || input.type.startsWith("EQUAL") ? 20 : 12;
  const touchScore = Math.min(20, input.touchedCount * 5);
  const unsweptScore = input.swept ? 0 : 12;
  const recencyScore = input.ageBars <= 20 ? 8 : input.ageBars <= 100 ? 4 : 0;
  return clamp(timeframeScore + typeScore + touchScore + unsweptScore + recencyScore, 0, 100);
}

export function findNearestLevels(levels: KeyLevel[], currentPrice: number): NearestLevels {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const insertion = lowerBoundPrice(sorted, currentPrice);
  const nearestSupport = insertion > 0 ? sorted[insertion - 1] : null;
  const nearestResistance = insertion < sorted.length ? sorted[insertion] : null;
  const bsl = sorted.filter((level) => level.type === "BSL" || level.type === "EQUAL_HIGH");
  const ssl = sorted.filter((level) => level.type === "SSL" || level.type === "EQUAL_LOW");
  const bslIndex = lowerBoundPrice(bsl, currentPrice);
  const sslIndex = lowerBoundPrice(ssl, currentPrice);
  return {
    nearestResistance,
    nearestSupport,
    nearestBSL: bsl[bslIndex] ?? bsl.at(-1) ?? null,
    nearestSSL: sslIndex > 0 ? ssl[sslIndex - 1] : ssl[0] ?? null,
    distanceToResistance: nearestResistance ? nearestResistance.price - currentPrice : null,
    distanceToSupport: nearestSupport ? currentPrice - nearestSupport.price : null,
  };
}

export function classifyRegimeFromMetrics(metrics: RegimeMetrics): MarketRegime {
  let regime: MarketRegime["regime"];
  if (!metrics.enoughData) regime = "WAIT";
  else if (metrics.liquidityGrab) regime = "LIQUIDITY_GRAB";
  else if (metrics.failedBreakout) regime = "FAKE_BREAKOUT";
  else if (metrics.reversalAttempt) regime = "REVERSAL_FORMING";
  else if (metrics.compression) regime = "COMPRESSION";
  else if (metrics.expansion && metrics.displacementRatio >= 0.15) regime = "MOMENTUM_EXPANSION";
  else if (metrics.volatility === "EXTREME_VOLATILITY" || metrics.volatility === "HIGH_VOLATILITY") regime = "HIGH_VOLATILITY";
  else if (metrics.volatility === "LOW_VOLATILITY") regime = "LOW_VOLATILITY";
  else if (metrics.structureBreaks > 0 && metrics.flow === "BULLISH" && metrics.expansion) regime = "BREAKOUT";
  else if (metrics.flow === "BULLISH" && metrics.overlapRatio < 0.6) regime = "TRENDING_BULLISH";
  else if (metrics.flow === "BEARISH" && metrics.overlapRatio < 0.6) regime = "TRENDING_BEARISH";
  else if (metrics.flow === "RANGING" && metrics.alternatingRatio < 0.65) regime = "RANGING";
  else regime = "CHOPPY";
  const chopRisk = clamp(Math.round((metrics.overlapRatio * 0.55 + metrics.alternatingRatio * 0.45) * 100), 0, 100);
  const confidence = clamp(Math.round(75 - chopRisk * 0.25 + metrics.structureBreaks * 4 + metrics.displacementRatio * 30), 20, 95);
  return {
    regime,
    confidence,
    trendQuality: clamp(100 - chopRisk + metrics.structureBreaks * 5, 0, 100),
    rangeQuality: clamp(Math.round(metrics.overlapRatio * 80 - metrics.alternatingRatio * 20), 0, 100),
    volatilityQuality: metrics.volatility === "NORMAL_VOLATILITY" ? 90 : metrics.volatility === "HIGH_VOLATILITY" ? 70 : 30,
    chopRisk,
    reason: `${regime.toLowerCase().replaceAll("_", " ")} from flow, overlap, alternation, displacement, structure, and ATR behavior.`,
    warnings: chopRisk >= 65 ? ["Candle overlap and direction alternation raise chop risk."] : [],
  };
}

export function detectSession(timestamp: number): TradingSession {
  const londonHour = zonedHour(timestamp, "Europe/London");
  const newYorkHour = zonedHour(timestamp, "America/New_York");
  const tokyoHour = zonedHour(timestamp, "Asia/Tokyo");
  const london = londonHour >= 8 && londonHour < 16;
  const newYork = newYorkHour >= 8 && newYorkHour < 17;
  const asian = tokyoHour >= 9 && tokyoHour < 16;
  if (london && newYork) return "LONDON_NEW_YORK_OVERLAP";
  if (london) return "LONDON";
  if (newYork) return "NEW_YORK";
  if (asian) return "ASIAN";
  return "DEAD_ZONE";
}

export function calculateVolatility(candles: Candle[], atrPeriod = 14): VolatilityContext {
  if (candles.length === 0) return { state: "LOW_VOLATILITY", atr: 0, atrPercentile: 0, averageRange: 0, expansionRatio: 0, warning: "No candle history for volatility.", reason: "Volatility is unavailable." };
  const atr = calculateRollingAtr(candles, atrPeriod);
  const currentAtr = atr.at(-1) ?? 0;
  const sample = atr.slice(-100);
  const averageAtr = average(sample);
  const percentile = Math.round((sample.filter((value) => value <= currentAtr).length / sample.length) * 100);
  const ranges = candles.slice(-20).map((candle) => candle.high - candle.low);
  const averageRange = average(ranges);
  const expansionRatio = safeRatio(currentAtr, averageAtr);
  const state = expansionRatio < 0.65
    ? "LOW_VOLATILITY"
    : expansionRatio <= 1.25
      ? "NORMAL_VOLATILITY"
      : expansionRatio <= 1.8
        ? "HIGH_VOLATILITY"
        : "EXTREME_VOLATILITY";
  const warning = state === "LOW_VOLATILITY"
    ? "Low volatility can amplify false micro breaks."
    : state === "EXTREME_VOLATILITY"
      ? "Extreme volatility increases slippage and immediate reversal risk."
      : null;
  return { state, atr: currentAtr, atrPercentile: percentile, averageRange, expansionRatio, warning, reason: `Current ATR is ${expansionRatio.toFixed(2)}x its recent average and sits near percentile ${percentile}.` };
}

export function clearMarketContextCache(): void {
  contextCache.clear();
}

function structureFor(input: MarketContextInput, candles: Candle[], role: string): MarketStructureResult {
  return calculateMarketStructure({
    candles,
    symbol: `${input.symbol}-${role}`,
    timeframe: input.timeframe,
    startDate: input.startDate,
    endDate: input.endDate,
    settings: input.marketStructureSettings,
  });
}

function calculateItfSetup(candles: Candle[], structure: MarketStructureResult): ItfSetupContext {
  const latestIndex = candles.length - 1;
  const latestPrice = candles.at(-1)?.close ?? 0;
  const recent = (index: number) => latestIndex - index <= 6;
  const sweep = structure.markers.findLast((marker) => (marker.type === "SSL_SWEEP" || marker.type === "BSL_SWEEP") && recent(marker.confirmedAtIndex)) as SweepMarker | undefined;
  const displacement = structure.markers.findLast((marker) => marker.type === "DISPLACEMENT" && recent(marker.confirmedAtIndex));
  const structural = structure.markers.findLast((marker) => (marker.type === "MSS" || marker.type === "CHOCH") && recent(marker.confirmedAtIndex));
  const direction = sweep?.direction ?? displacement?.direction ?? structural?.direction ?? "NONE";
  const liquidity = structure.liquidityZones
    .filter((zone) => !zone.swept)
    .sort((a, b) => Math.abs(a.price - latestPrice) - Math.abs(b.price - latestPrice))[0];
  const atr = structure.atr.at(-1) ?? 0;
  const sweepProximity = Boolean(liquidity && Math.abs(liquidity.price - latestPrice) <= atr);
  const fvg = structure.fvgZones.findLast((zone) => !zone.mitigated && (direction === "NONE" || zone.direction === direction));
  const inPullback = Boolean(fvg && latestPrice >= fvg.minPrice && latestPrice <= fvg.maxPrice);
  const invalidation = direction === "BULLISH"
    ? structure.markers.findLast((marker) => marker.type === "SWING_LOW")?.price ?? null
    : direction === "BEARISH"
      ? structure.markers.findLast((marker) => marker.type === "SWING_HIGH")?.price ?? null
      : null;
  const invalidated = invalidation !== null && ((direction === "BULLISH" && latestPrice < invalidation) || (direction === "BEARISH" && latestPrice > invalidation));
  return evaluateItfSetup({
    direction: direction === "NEUTRAL" ? "MIXED" : direction,
    liquidityId: liquidity?.id,
    sweepProximity,
    sweepId: sweep?.id,
    displacementId: displacement?.id,
    structureId: structural?.id,
    pullbackZone: inPullback && fvg ? { minPrice: fvg.minPrice, maxPrice: fvg.maxPrice } : undefined,
    invalidated,
    invalidation: invalidation ?? undefined,
  });
}

function buildKeyLevels(input: {
  candles: Candle[];
  ltfStructure: MarketStructureResult;
  itfStructure: MarketStructureResult;
  htfStructure: MarketStructureResult;
  session: SessionContext;
}): KeyLevel[] {
  const currentPrice = input.candles.at(-1)?.close ?? 0;
  const levels: KeyLevel[] = [];
  addStructureLevels(levels, input.ltfStructure, "LTF", currentPrice);
  addStructureLevels(levels, input.itfStructure, "ITF", currentPrice);
  addStructureLevels(levels, input.htfStructure, "HTF", currentPrice);
  const recent = input.candles.slice(-50);
  const lastTimestamp = input.candles.at(-1)?.timestamp ?? Date.now();
  if (recent.length) {
    pushSimpleLevel(levels, "CURRENT_RANGE_HIGH", Math.max(...recent.map((c) => c.high)), "LTF", currentPrice, lastTimestamp);
    pushSimpleLevel(levels, "CURRENT_RANGE_LOW", Math.min(...recent.map((c) => c.low)), "LTF", currentPrice, lastTimestamp);
  }
  if (input.session.previousSessionHigh !== null) pushSimpleLevel(levels, "PREVIOUS_SESSION_HIGH", input.session.previousSessionHigh, "ITF", currentPrice, lastTimestamp);
  if (input.session.previousSessionLow !== null) pushSimpleLevel(levels, "PREVIOUS_SESSION_LOW", input.session.previousSessionLow, "ITF", currentPrice, lastTimestamp);
  const previousDay = getPreviousDayRange(input.candles);
  if (previousDay) {
    pushSimpleLevel(levels, "PREVIOUS_DAY_HIGH", previousDay.high, "HTF", currentPrice, lastTimestamp);
    pushSimpleLevel(levels, "PREVIOUS_DAY_LOW", previousDay.low, "HTF", currentPrice, lastTimestamp);
  }
  return levels.sort((a, b) => a.price - b.price);
}

function addStructureLevels(levels: KeyLevel[], structure: MarketStructureResult, timeframe: KeyLevel["timeframe"], currentPrice: number): void {
  for (const zone of structure.liquidityZones) {
    const type = zone.touches > 1 ? (zone.type === "BSL" ? "EQUAL_HIGH" : "EQUAL_LOW") : zone.type;
    levels.push(makeLevel({ id: `${timeframe}-${zone.id}`, type, timeframe, price: zone.price, minPrice: zone.minPrice, maxPrice: zone.maxPrice, touchedCount: zone.touches, swept: zone.swept, lastTouchedAt: zone.sweptAt ?? zone.timestamp, currentPrice, ageBars: structure.candles.length - zone.endIndex, reason: zone.reason }));
  }
  for (const marker of structure.markers) {
    if (marker.type === "SWING_HIGH" || marker.type === "SWING_LOW") {
      levels.push(makeLevel({ id: `${timeframe}-${marker.id}`, type: marker.type === "SWING_HIGH" ? "MAJOR_SWING_HIGH" : "MAJOR_SWING_LOW", timeframe, price: marker.price, minPrice: marker.price, maxPrice: marker.price, touchedCount: 1, swept: false, lastTouchedAt: marker.timestamp, currentPrice, ageBars: structure.candles.length - marker.candleIndex, reason: marker.reason }));
    }
    if (marker.type === "FVG") {
      levels.push(makeLevel({ id: `${timeframe}-${marker.id}`, type: "FVG", timeframe, price: (marker.minPrice + marker.maxPrice) / 2, minPrice: marker.minPrice, maxPrice: marker.maxPrice, touchedCount: marker.mitigated ? 1 : 0, swept: marker.mitigated, lastTouchedAt: marker.mitigatedAt ?? marker.timestamp, currentPrice, ageBars: structure.candles.length - marker.endIndex, reason: marker.reason }));
    }
  }
}

function makeLevel(input: Omit<KeyLevel, "strength" | "distanceFromCurrentPrice"> & { currentPrice: number; ageBars: number }): KeyLevel {
  const { currentPrice, ageBars, ...level } = input;
  return {
    ...level,
    strength: scoreKeyLevel({
      timeframe: level.timeframe,
      type: level.type,
      touchedCount: level.touchedCount,
      swept: level.swept,
      ageBars,
    }),
    distanceFromCurrentPrice: Math.abs(level.price - currentPrice),
  };
}

function pushSimpleLevel(levels: KeyLevel[], type: KeyLevel["type"], price: number, timeframe: KeyLevel["timeframe"], currentPrice: number, timestamp: number): void {
  levels.push(makeLevel({ id: `${type}-${price}`, type, timeframe, price, minPrice: price, maxPrice: price, touchedCount: 1, lastTouchedAt: timestamp, swept: false, currentPrice, ageBars: 0, reason: `${type.toLowerCase().replaceAll("_", " ")} derived from completed candles.` }));
}

function calculateRegime(candles: Candle[], structure: MarketStructureResult, volatility: VolatilityContext, reading: ReturnType<typeof analyzeCandleReading>): MarketRegime {
  const recent = candles.slice(-20);
  let overlaps = 0;
  let alternations = 0;
  for (let index = 1; index < recent.length; index += 1) {
    if (recent[index].low <= recent[index - 1].high && recent[index].high >= recent[index - 1].low) overlaps += 1;
    if ((recent[index].close > recent[index].open) !== (recent[index - 1].close > recent[index - 1].open)) alternations += 1;
  }
  const features = reading?.sequence.features ?? [];
  return classifyRegimeFromMetrics({
    flow: reading?.sequence.shortTermFlow ?? "CHOPPY",
    volatility: volatility.state,
    overlapRatio: safeRatio(overlaps, recent.length - 1),
    alternatingRatio: safeRatio(alternations, recent.length - 1),
    displacementRatio: safeRatio(structure.markers.filter((marker) => marker.type === "DISPLACEMENT" && marker.confirmedAtIndex >= candles.length - 20).length, recent.length),
    structureBreaks: structure.markers.filter((marker) => (marker.type === "BOS" || marker.type === "CHOCH" || marker.type === "MSS") && marker.confirmedAtIndex >= candles.length - 20).length,
    compression: reading?.sequence.volatilityState === "CONTRACTING",
    expansion: reading?.sequence.volatilityState === "EXPANDING",
    failedBreakout: features.some((feature) => feature.includes("failed")),
    liquidityGrab: features.some((feature) => feature.includes("liquidity grab")),
    reversalAttempt: features.some((feature) => feature.includes("reversal attempt")),
    enoughData: recent.length >= 10,
  });
}

export function calculateSessionContext(candles: Candle[], displayTimezone = "UTC"): SessionContext {
  if (!candles.length) return { session: "DEAD_ZONE", displayTimezone, sessionQuality: 0, sessionOpen: null, sessionClose: null, currentSessionHigh: null, currentSessionLow: null, previousSessionHigh: null, previousSessionLow: null, sessionBias: "NEUTRAL", reason: "No completed candles for session context." };
  const latestSession = detectSession(candles.at(-1)!.timestamp);
  let cursor = candles.length - 1;
  while (cursor >= 0 && detectSession(candles[cursor].timestamp) === latestSession) cursor -= 1;
  const current = candles.slice(cursor + 1);
  let previousEnd = cursor;
  while (previousEnd >= 0 && detectSession(candles[previousEnd].timestamp) === "DEAD_ZONE") previousEnd -= 1;
  const previousType = previousEnd >= 0 ? detectSession(candles[previousEnd].timestamp) : null;
  let previousStart = previousEnd;
  while (previousStart >= 0 && detectSession(candles[previousStart].timestamp) === previousType) previousStart -= 1;
  const previous = previousEnd >= 0 ? candles.slice(previousStart + 1, previousEnd + 1) : [];
  const quality: Record<TradingSession, number> = { ASIAN: 55, LONDON: 82, NEW_YORK: 80, LONDON_NEW_YORK_OVERLAP: 92, DEAD_ZONE: 20 };
  const first = current[0];
  const last = current.at(-1)!;
  const sessionBias = last.close > first.open ? "BULLISH" : last.close < first.open ? "BEARISH" : "NEUTRAL";
  return {
    session: latestSession,
    displayTimezone,
    sessionQuality: quality[latestSession],
    sessionOpen: first.timestamp,
    sessionClose: last.closeTime ?? last.timestamp,
    currentSessionHigh: Math.max(...current.map((candle) => candle.high)),
    currentSessionLow: Math.min(...current.map((candle) => candle.low)),
    previousSessionHigh: previous.length ? Math.max(...previous.map((candle) => candle.high)) : null,
    previousSessionLow: previous.length ? Math.min(...previous.map((candle) => candle.low)) : null,
    sessionBias,
    reason: latestSession === "DEAD_ZONE" ? "Dead-zone liquidity and follow-through are commonly weaker." : `${latestSession.toLowerCase().replaceAll("_", " ")} session is active; quality reflects typical participation, not certainty.`,
  };
}

function buildWaitContext(input: { htfBias: HtfBias; itfSetup: ItfSetupContext; premiumDiscount: PremiumDiscountContext | null; regime: MarketRegime; session: SessionContext; volatility: VolatilityContext; nearestLevels: NearestLevels }): WaitContext {
  const waitReasons: string[] = [];
  const required: string[] = [];
  if (["UNKNOWN", "NEUTRAL", "RANGING"].includes(input.htfBias.bias)) { waitReasons.push("HTF bias is unclear."); required.push("A clean HTF structure break or directional hold."); }
  if (["CHOPPY", "WAIT"].includes(input.regime.regime)) { waitReasons.push("Market structure is choppy or incomplete."); required.push("Lower overlap and cleaner follow-through."); }
  if (input.premiumDiscount?.zone === "EQUILIBRIUM") { waitReasons.push("Price is near dealing-range equilibrium."); required.push("Price acceptance in premium or discount."); }
  if (input.itfSetup.setupState === "NO_SETUP" || input.itfSetup.setupState === "LIQUIDITY_BUILDING") { waitReasons.push("ITF setup environment is incomplete."); required.push("A confirmed sweep, displacement, or structure shift."); }
  if (input.volatility.state === "LOW_VOLATILITY" || input.volatility.state === "EXTREME_VOLATILITY") { waitReasons.push(`Volatility is ${input.volatility.state.toLowerCase().replaceAll("_", " ")}.`); required.push("Volatility returning to a stable range."); }
  if (input.session.sessionQuality < 40) { waitReasons.push("Active session quality is low."); required.push("A higher-participation session."); }
  if (!input.nearestLevels.nearestSupport && !input.nearestLevels.nearestResistance) { waitReasons.push("No nearby key levels are available."); required.push("More completed history or a confirmed key level."); }
  return { shouldWait: waitReasons.length >= 2, waitReasons, requiredForImprovement: [...new Set(required)] };
}

function calculateContextScore(input: { htfBias: HtfBias; itfSetup: ItfSetupContext; premiumDiscount: PremiumDiscountContext | null; regime: MarketRegime; session: SessionContext; volatility: VolatilityContext; nearestLevels: NearestLevels; wait: WaitContext }): ContextScore {
  const htf = Math.round(input.htfBias.strength * 0.2);
  const itf = Math.round(input.itfSetup.strength * 0.2);
  const locationQuality = input.htfBias.bias === "BULLISH" ? input.premiumDiscount?.buyQuality ?? 0 : input.htfBias.bias === "BEARISH" ? input.premiumDiscount?.sellQuality ?? 0 : 30;
  const location = Math.round(locationQuality * 0.15);
  const regime = Math.round((100 - input.regime.chopRisk) * 0.15);
  const session = Math.round(input.session.sessionQuality * 0.1);
  const volatilityQuality = input.volatility.state === "NORMAL_VOLATILITY" ? 100 : input.volatility.state === "HIGH_VOLATILITY" ? 75 : 25;
  const volatility = Math.round(volatilityQuality * 0.1);
  const levelStrength = Math.max(input.nearestLevels.nearestSupport?.strength ?? 0, input.nearestLevels.nearestResistance?.strength ?? 0);
  const levels = Math.round(levelStrength * 0.1);
  const overallScore = clamp(htf + itf + location + regime + session + volatility + levels, 0, 100);
  const directionPreference = input.wait.shouldWait ? "WAIT" : input.htfBias.bias === "BULLISH" ? "BULLISH" : input.htfBias.bias === "BEARISH" ? "BEARISH" : "NEUTRAL";
  const tradeEnvironment = input.wait.shouldWait ? "WAIT" : overallScore >= 75 ? "GOOD" : overallScore >= 50 ? "MODERATE" : "POOR";
  return { overallScore, directionPreference, tradeEnvironment, reason: `Context score ${overallScore}/100 combines HTF clarity, ITF maturity, location, regime, session, volatility, and nearby levels.`, warnings: input.wait.waitReasons };
}

function getPreviousDayRange(candles: Candle[]): { high: number; low: number } | null {
  const days = new Map<string, Candle[]>();
  for (const candle of candles) {
    const day = new Date(candle.timestamp).toISOString().slice(0, 10);
    const group = days.get(day) ?? [];
    group.push(candle);
    days.set(day, group);
  }
  const entries = [...days.values()];
  if (entries.length < 2) return null;
  const previous = entries.at(-2)!;
  return { high: Math.max(...previous.map((candle) => candle.high)), low: Math.min(...previous.map((candle) => candle.low)) };
}

function lowerBoundPrice(levels: KeyLevel[], price: number): number {
  let low = 0;
  let high = levels.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (levels[middle].price < price) low = middle + 1;
    else high = middle;
  }
  return low;
}

function zonedHour(timestamp: number, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).formatToParts(timestamp).find((part) => part.type === "hour")?.value;
  return Number(hour ?? 0);
}

function buildContextKey(input: MarketContextInput, candles: Candle[]): string {
  const settings = input.marketStructureSettings;
  const last = candles.at(-1);
  return [input.symbol, input.timeframe, input.startDate, input.endDate, candles.length, candles[0]?.timestamp ?? 0, last?.timestamp ?? 0, last?.close ?? 0, settings.sensitivity, settings.leftBars, settings.rightBars, settings.atrPeriod, settings.showOnlyMajor, input.displayTimezone ?? "local"].join(":");
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function safeRatio(value: number, denominator: number): number {
  return denominator > 0 ? value / denominator : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
