import type { Candle } from "../candles/types";
import type { KeyLevel, MarketContextResult } from "../market-context/types";
import type {
  FvgZone,
  LiquidityZone,
  MarketMarker,
  MomentumMarker,
  StructureMarker,
  SweepMarker,
} from "../market-structure/types";
import type {
  AntiReversalResult,
  MarketSetup,
  SetupDirection,
  SetupInvalidation,
  SetupScannerInput,
  SetupScannerResult,
  SetupScannerSettings,
  SetupScoreBreakdown,
  SetupState,
  SetupTarget,
  SetupType,
  SetupZone,
} from "./types";

const DEFAULT_SETTINGS: SetupScannerSettings = {
  maxSetupAgeBars: 12,
  maxWatchAgeBars: 24,
  proximityAtrMultiplier: 1.25,
  extensionAtrMultiplier: 2.5,
  maxActiveSetups: 8,
};

const scannerCache = new Map<string, SetupScannerResult>();
const VALID_TRANSITIONS: Record<SetupState, SetupState[]> = {
  WATCH: ["SETUP", "INVALIDATED"],
  SETUP: ["TRIGGER", "INVALIDATED", "EXPIRED"],
  TRIGGER: ["EXPIRED"],
  INVALIDATED: [],
  EXPIRED: [],
};

type ScoreEvidence = {
  direction: SetupDirection;
  context: MarketContextResult;
  liquidity?: LiquidityZone | KeyLevel | null;
  sweep?: SweepMarker | null;
  displacement?: MomentumMarker | null;
  structure?: StructureMarker | null;
  locationMatch?: boolean;
  psychologyMatch?: boolean;
  setupType: SetupType;
};

export function getDefaultSetupScannerSettings(): SetupScannerSettings {
  return { ...DEFAULT_SETTINGS };
}

export function scanSetups(input: SetupScannerInput): SetupScannerResult {
  const started = performance.now();
  const settings = { ...DEFAULT_SETTINGS, ...input.settings };
  const candles = input.candles.filter((candle) => candle.isClosed);
  const lastIndex = candles.length - 1;
  const key = buildCacheKey(input, candles, settings);
  const cached = scannerCache.get(key);
  if (cached) return cloneResult(cached, "hit");

  if (lastIndex < 0) {
    return emptyResult(performance.now() - started);
  }

  const markers = input.structure.markers.filter(
    (marker) => marker.confirmedAtIndex <= lastIndex,
  );
  const liquidity = input.structure.liquidityZones.filter(
    (zone) => zone.confirmedAtIndex <= lastIndex,
  );
  const liquidityMap = new Map(liquidity.map((zone) => [zone.id, zone]));
  const activeMap = new Map<string, MarketSetup>();
  const discovered: MarketSetup[] = [];

  for (const setup of scanSweepReversals(input, candles, markers, liquidityMap, settings)) {
    rememberSetup(activeMap, discovered, setup);
  }
  for (const setup of scanTrendContinuations(input, candles, markers, settings)) {
    rememberSetup(activeMap, discovered, setup);
  }
  for (const setup of scanCompressionBreakout(input, candles, markers, settings)) {
    rememberSetup(activeMap, discovered, setup);
  }
  for (const setup of scanRangeReversals(input, candles, markers, liquidity, settings)) {
    rememberSetup(activeMap, discovered, setup);
  }

  const setups = discovered
    .filter((setup) => setup.score >= 40 || setup.state === "INVALIDATED" || setup.state === "EXPIRED")
    .sort(compareSetups)
    .slice(0, Math.max(settings.maxActiveSetups + 8, 12));
  const setupMap = new Map(setups.map((setup) => [setup.id, setup]));
  const activeSetups = setups.filter((setup) => !isTerminal(setup.state)).slice(0, settings.maxActiveSetups);
  const invalidatedSetups = setups.filter((setup) => setup.state === "INVALIDATED");
  const expiredSetups = setups.filter((setup) => setup.state === "EXPIRED");
  const noFuture = setups.every((setup) => evidenceIsCausal(setup, lastIndex));
  const result: SetupScannerResult = {
    setups,
    activeSetups,
    invalidatedSetups,
    expiredSetups,
    setupMap,
    audit: {
      processedCandles: candles.length,
      currentCandleIndex: lastIndex,
      activeSetupCount: activeSetups.length,
      watchCount: setups.filter((setup) => setup.state === "WATCH").length,
      setupCount: setups.filter((setup) => setup.state === "SETUP").length,
      triggerCount: setups.filter((setup) => setup.state === "TRIGGER").length,
      invalidatedCount: invalidatedSetups.length,
      expiredCount: expiredSetups.length,
      transitionCount: setups.reduce((total, setup) => total + setup.history.length, 0),
      calculationTimeMs: Math.round((performance.now() - started) * 100) / 100,
      cacheStatus: "miss",
      noFutureValidation: noFuture ? "pass" : "warning",
    },
  };

  if (scannerCache.size >= 40) scannerCache.delete(scannerCache.keys().next().value ?? "");
  scannerCache.set(key, result);
  return result;
}

export function transitionSetup(
  setup: MarketSetup,
  to: SetupState,
  candle: Candle,
  candleIndex: number,
  reason: string,
): MarketSetup {
  if (!VALID_TRANSITIONS[setup.state].includes(to)) return setup;
  return {
    ...setup,
    state: to,
    updatedAt: candle.timestamp,
    updatedAtIndex: candleIndex,
    history: [...setup.history, { from: setup.state, to, timestamp: candle.timestamp, candleIndex, reason }],
    reasons: to === "SETUP" || to === "TRIGGER" ? [...setup.reasons, reason] : setup.reasons,
    failedReasons: to === "INVALIDATED" || to === "EXPIRED" ? [...setup.failedReasons, reason] : setup.failedReasons,
  };
}

export function calculateSetupScore(evidence: ScoreEvidence): {
  score: number;
  breakdown: SetupScoreBreakdown;
} {
  const direction = evidence.direction;
  const htfAligned = evidence.context.htfBias.bias === direction;
  const htfNeutral = ["NEUTRAL", "RANGING", "UNKNOWN"].includes(evidence.context.htfBias.bias);
  const itfAligned = evidence.context.itfSetup.direction === direction;
  const itfNeutral = evidence.context.itfSetup.direction === "NONE" || evidence.context.itfSetup.direction === "MIXED";
  const preferredSession =
    (evidence.setupType === "RANGE_REVERSAL" && evidence.context.session.session === "ASIAN") ||
    (evidence.setupType === "LIQUIDITY_SWEEP_REVERSAL" && evidence.context.session.session.includes("LONDON")) ||
    (evidence.setupType === "TREND_CONTINUATION" && evidence.context.session.session.includes("NEW_YORK"));
  const volatility = evidence.context.volatility.state;
  const breakdown: SetupScoreBreakdown = {
    htfContext: htfAligned ? Math.min(15, 8 + Math.round(evidence.context.htfBias.strength * 0.07)) : htfNeutral ? 7 : 1,
    itfQuality: itfAligned ? Math.min(15, 8 + Math.round(evidence.context.itfSetup.strength * 0.07)) : itfNeutral ? 7 : 2,
    liquidityQuality: evidence.liquidity ? Math.min(15, 8 + Math.round(("strength" in evidence.liquidity ? evidence.liquidity.strength : 1) * 2)) : 2,
    sweepDisplacement: evidence.sweep && evidence.displacement ? 15 : evidence.sweep || evidence.displacement ? 9 : 2,
    structureQuality: evidence.structure ? Math.min(15, 9 + evidence.structure.strength * 2) : 3,
    premiumDiscount: evidence.locationMatch ? 10 : evidence.context.premiumDiscount?.zone === "EQUILIBRIUM" ? 2 : 5,
    sessionQuality: clamp(Math.round(evidence.context.session.sessionQuality / 20) + (preferredSession ? 1 : 0), 0, 5),
    volatilityQuality: volatility === "NORMAL_VOLATILITY" ? 5 : volatility === "HIGH_VOLATILITY" ? 4 : volatility === "LOW_VOLATILITY" && evidence.setupType === "COMPRESSION_BREAKOUT" ? 4 : 1,
    candlePsychology: evidence.psychologyMatch ? 5 : 1,
  };
  return {
    score: clamp(Object.values(breakdown).reduce((total, value) => total + value, 0), 0, 100),
    breakdown,
  };
}

export function evaluateAntiReversal(input: {
  direction: SetupDirection;
  zone: SetupZone;
  currentPrice: number;
  atr: number;
  context: MarketContextResult;
  reversalRisk?: "LOW" | "MEDIUM" | "HIGH";
  latestBodyRatio?: number;
  hasFollowThrough?: boolean;
  extensionAtrMultiplier?: number;
}): AntiReversalResult {
  const warnings: string[] = [];
  const distance = distanceToZone(input.currentPrice, input.zone);
  if (input.atr > 0 && distance > input.atr * (input.extensionAtrMultiplier ?? DEFAULT_SETTINGS.extensionAtrMultiplier)) {
    warnings.push("Price is too extended from the setup zone; do not chase.");
  }
  if (input.context.regime.chopRisk >= 70 || input.context.regime.regime === "CHOPPY") warnings.push("Market overlap and chop risk are high.");
  if (input.context.volatility.state === "EXTREME_VOLATILITY") warnings.push("Extreme volatility can cause immediate reversal or slippage.");
  if ((input.latestBodyRatio ?? 1) < 0.25) warnings.push("Latest candle is wick-heavy with a weak body.");
  if (input.hasFollowThrough === false) warnings.push("Displacement has no confirmed follow-through yet.");
  if (input.context.premiumDiscount?.zone === "EQUILIBRIUM") warnings.push("Price is near equilibrium with limited directional edge.");
  if (input.context.htfBias.bias !== input.direction && !["NEUTRAL", "RANGING", "UNKNOWN"].includes(input.context.htfBias.bias)) warnings.push("Higher-timeframe bias opposes this setup.");
  if (input.context.session.session === "DEAD_ZONE") warnings.push("Dead-zone participation reduces follow-through quality.");
  if (input.reversalRisk === "HIGH") warnings.push("Phase 2.5 candle reading reports high reversal risk.");

  const oppositeDistance = input.direction === "BULLISH"
    ? input.context.nearestLevels.distanceToResistance
    : input.context.nearestLevels.distanceToSupport;
  if (oppositeDistance !== null && input.atr > 0 && oppositeDistance < input.atr * 0.75) warnings.push("Opposite liquidity is too close to the projected path.");
  const highWeight = warnings.filter((warning) =>
    warning.includes("too extended") || warning.includes("Extreme") || warning.includes("opposes") || warning.includes("high reversal"),
  ).length;
  const reversalRisk = highWeight >= 2 || warnings.length >= 5 ? "HIGH" : warnings.length >= 2 ? "MEDIUM" : "LOW";
  return { reversalRisk, warnings, shouldAvoid: reversalRisk === "HIGH" };
}

export function findNearestTarget(
  levels: KeyLevel[],
  price: number,
  direction: SetupDirection,
): SetupTarget | null {
  if (direction === "NEUTRAL" || levels.length === 0) return null;
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const insertion = lowerBound(sorted, price);
  const candidates = direction === "BULLISH"
    ? sorted.slice(insertion).filter((level) => level.price > price && !level.swept)
    : sorted.slice(0, insertion).reverse().filter((level) => level.price < price && !level.swept);
  const preferred = candidates.find((level) => direction === "BULLISH"
    ? ["BSL", "EQUAL_HIGH", "MAJOR_SWING_HIGH", "CURRENT_RANGE_HIGH"].includes(level.type)
    : ["SSL", "EQUAL_LOW", "MAJOR_SWING_LOW", "CURRENT_RANGE_LOW"].includes(level.type)) ?? candidates[0];
  if (!preferred) return null;
  return {
    targetType: preferred.type,
    price: preferred.price,
    distance: Math.abs(preferred.price - price),
    strength: preferred.strength,
    reason: `Nearest unswept ${preferred.type.toLowerCase().replaceAll("_", " ")} in the setup direction.`,
  };
}

export function clearSetupScannerCache(): void {
  scannerCache.clear();
}

function scanSweepReversals(
  input: SetupScannerInput,
  candles: Candle[],
  markers: MarketMarker[],
  zones: Map<string, LiquidityZone>,
  settings: SetupScannerSettings,
): MarketSetup[] {
  const lastIndex = candles.length - 1;
  const sweeps = markers.filter(isSweep);
  const setups: MarketSetup[] = [];
  for (const sweep of sweeps) {
    const direction = sweep.direction;
    const liquidity = zones.get(sweep.sweptLiquidityId) ?? null;
    if (!liquidity) continue;
    const displacement = findAfter(markers, sweep.confirmedAtIndex, 8, (marker): marker is MomentumMarker => marker.type === "DISPLACEMENT" && marker.direction === direction);
    const structure = displacement
      ? findAfter(markers, displacement.confirmedAtIndex, 10, (marker): marker is StructureMarker => isStructure(marker) && marker.direction === direction)
      : null;
    const fvg = displacement ? findRelatedFvg(markers, displacement.confirmedAtIndex, direction) : null;
    const setupZone = calculateZone({ type: "LIQUIDITY_SWEEP_REVERSAL", direction, candles, liquidity, displacement, fvg, anchorIndex: sweep.confirmedAtIndex });
    const invalidation = invalidationForSweep(direction, sweep);
    const score = calculateSetupScore({
      direction,
      context: input.context,
      liquidity,
      sweep,
      displacement,
      structure,
      locationMatch: isLocationAligned(direction, input.context),
      psychologyMatch: psychologySupports(direction, input),
      setupType: "LIQUIDITY_SWEEP_REVERSAL",
    });
    const anti = antiFor(input, candles, setupZone, direction, Boolean(displacement && structure), settings);
    let setup = createSetup(input, candles, {
      id: `sweep-reversal:${sweep.id}`,
      type: "LIQUIDITY_SWEEP_REVERSAL",
      direction,
      createdIndex: Math.max(0, Math.min(liquidity.confirmedAtIndex, sweep.confirmedAtIndex - 1)),
      evidenceIndexes: [liquidity.confirmedAtIndex, sweep.confirmedAtIndex, displacement?.confirmedAtIndex, structure?.confirmedAtIndex, fvg?.confirmedAtIndex],
      liquidity,
      sweep,
      displacement,
      structure,
      fvg,
      setupZone,
      invalidation,
      score,
      anti,
      reasons: [`${liquidity.type} liquidity was available near price.`, sweep.reason],
    });
    if (displacement && score.score >= 50) {
      setup = transitionSetup(setup, "SETUP", candles[displacement.confirmedAtIndex], displacement.confirmedAtIndex, `${directionLabel(direction)} displacement confirmed rejection after the liquidity sweep.`);
    }
    if (setup.state === "SETUP" && displacement && score.score >= 55) {
      const triggerAnchor = Math.max(
        displacement.confirmedAtIndex,
        structure?.confirmedAtIndex ?? -1,
        fvg?.confirmedAtIndex ?? -1,
      );
      const pullback = findZoneTouch(candles, setupZone, triggerAnchor + 1, lastIndex, invalidation, direction);
      if (pullback !== null) {
        const source = structure ? structure.type : "DISPLACEMENT";
        setup = transitionSetup(setup, "TRIGGER", candles[pullback], pullback, `${source} confirmed and a later closed candle held the setup zone.`);
      }
    }
    setup = applyFailureAndExpiry(setup, candles, markers, settings);
    setups.push(setup);
  }
  return setups;
}

function scanTrendContinuations(
  input: SetupScannerInput,
  candles: Candle[],
  markers: MarketMarker[],
  settings: SetupScannerSettings,
): MarketSetup[] {
  const bias = input.context.htfBias.bias;
  if (bias !== "BULLISH" && bias !== "BEARISH") return [];
  const direction = bias;
  const lastIndex = candles.length - 1;
  const recentStart = Math.max(2, lastIndex - 18);
  const pullbackIndex = findPullbackIndex(candles, direction, recentStart, lastIndex);
  if (pullbackIndex === null) return [];
  const displacement = findAfter(markers, pullbackIndex, 12, (marker): marker is MomentumMarker => marker.type === "DISPLACEMENT" && marker.direction === direction);
  const structure = findAfter(markers, pullbackIndex, 14, (marker): marker is StructureMarker => isStructure(marker) && marker.direction === direction);
  const fvg = findBestFvg(markers, direction, pullbackIndex);
  const setupZone = calculateZone({ type: "TREND_CONTINUATION", direction, candles, liquidity: null, displacement, fvg, anchorIndex: pullbackIndex });
  const pullbackSlice = candles.slice(Math.max(0, pullbackIndex - 3), Math.min(candles.length, pullbackIndex + 4));
  const extreme = direction === "BULLISH" ? Math.min(...pullbackSlice.map((c) => c.low)) : Math.max(...pullbackSlice.map((c) => c.high));
  const invalidation: SetupInvalidation = { price: extreme, source: "PULLBACK_EXTREME", reason: `${directionLabel(direction)} continuation fails beyond the completed pullback extreme.` };
  const locationMatch = isLocationAligned(direction, input.context) || zoneTouched(candles[pullbackIndex], setupZone);
  const score = calculateSetupScore({ direction, context: input.context, liquidity: nearestDirectionalLevel(input.context, direction), displacement, structure, locationMatch, psychologyMatch: psychologySupports(direction, input), setupType: "TREND_CONTINUATION" });
  const anti = antiFor(input, candles, setupZone, direction, Boolean(displacement && structure), settings);
  let setup = createSetup(input, candles, {
    id: `continuation:${direction}:${candles[pullbackIndex].timestamp}`,
    type: "TREND_CONTINUATION",
    direction,
    createdIndex: pullbackIndex,
    evidenceIndexes: [pullbackIndex, displacement?.confirmedAtIndex, structure?.confirmedAtIndex, fvg?.confirmedAtIndex],
    liquidity: null,
    sweep: null,
    displacement,
    structure,
    fvg,
    setupZone,
    invalidation,
    score,
    anti,
    reasons: [`HTF bias is ${direction.toLowerCase()} and price formed a completed pullback.`],
  });
  if (score.score >= 60 && locationMatch && psychologySupports(direction, input)) {
    setup = transitionSetup(setup, "SETUP", candles[pullbackIndex], pullbackIndex, "Pullback reached a contextual support zone and adverse extremes stopped extending.");
  }
  const triggerIndex = Math.max(displacement?.confirmedAtIndex ?? -1, structure?.confirmedAtIndex ?? -1);
  if (setup.state === "SETUP" && displacement && structure && triggerIndex > pullbackIndex && score.score >= 75 && !anti.shouldAvoid) {
    setup = transitionSetup(setup, "TRIGGER", candles[triggerIndex], triggerIndex, `${directionLabel(direction)} LTF structure shift and displacement confirmed after the pullback.`);
  }
  setup = applyFailureAndExpiry(setup, candles, markers, settings);
  return [setup];
}

function scanCompressionBreakout(
  input: SetupScannerInput,
  candles: Candle[],
  markers: MarketMarker[],
  settings: SetupScannerSettings,
): MarketSetup[] {
  if (candles.length < 8) return [];
  const lastIndex = candles.length - 1;
  const breakout = findCompressionBreakout(candles);
  const range = breakout?.range ?? compressionRange(candles.slice(-10));
  const compression = breakout !== null || isCompressed(candles.slice(-10)) || input.context.regime.regime === "COMPRESSION";
  if (!compression || !range) return [];
  const direction: SetupDirection = breakout?.direction ?? "NEUTRAL";
  const createdIndex = breakout ? breakout.index - 1 : Math.max(0, lastIndex - 1);
  const anchorPrice = direction === "BEARISH" ? range.low : range.high;
  const width = Math.max(input.context.volatility.atr * 0.12, (range.high - range.low) * 0.04, Number.EPSILON);
  const setupZone: SetupZone = {
    type: "RANGE_RETEST",
    minPrice: anchorPrice - width,
    maxPrice: anchorPrice + width,
    midpoint: anchorPrice,
    createdFrom: `compression-range:${createdIndex}`,
    strength: compression ? 80 : 50,
    reason: "Retest band around the completed compression boundary.",
  };
  const invalidation: SetupInvalidation = {
    price: direction === "BEARISH" ? range.high : range.low,
    source: "RANGE_EDGE",
    reason: "The opposite compression edge invalidates the breakout thesis.",
  };
  const displacement = breakout ? findAtOrAfter(markers, breakout.index, 2, (marker): marker is MomentumMarker => marker.type === "DISPLACEMENT" && marker.direction === direction) : null;
  const followThrough = breakout ? findBreakoutRetest(candles, breakout.index, range, direction) : null;
  const scoringDirection = direction === "NEUTRAL" && (input.context.score.directionPreference === "BULLISH" || input.context.score.directionPreference === "BEARISH")
    ? input.context.score.directionPreference
    : direction;
  const score = calculateSetupScore({ direction: scoringDirection, context: input.context, liquidity: nearestDirectionalLevel(input.context, scoringDirection), displacement, structure: null, locationMatch: Boolean(followThrough), psychologyMatch: direction !== "NEUTRAL" && psychologySupports(direction, input), setupType: "COMPRESSION_BREAKOUT" });
  const anti = antiFor(input, candles, setupZone, direction, followThrough !== null, settings);
  let setup = createSetup(input, candles, {
    id: `compression:${candles[createdIndex].timestamp}:${direction}`,
    type: "COMPRESSION_BREAKOUT",
    direction,
    createdIndex,
    evidenceIndexes: [createdIndex, breakout?.index, displacement?.confirmedAtIndex, followThrough],
    liquidity: null,
    sweep: null,
    displacement,
    structure: null,
    fvg: null,
    setupZone,
    invalidation,
    score,
    anti,
    reasons: ["Candle ranges contracted with overlap around a defined high and low."],
  });
  if (breakout && displacement && score.score >= 60 && !breakout.extended) {
    setup = transitionSetup(setup, "SETUP", candles[displacement.confirmedAtIndex], displacement.confirmedAtIndex, `${directionLabel(direction)} close broke the compression range with displacement.`);
  }
  if (setup.state === "SETUP" && followThrough !== null && displacement && followThrough >= displacement.confirmedAtIndex && score.score >= 75 && !anti.shouldAvoid) {
    setup = transitionSetup(setup, "TRIGGER", candles[followThrough], followThrough, "Range retest held and a closed follow-through candle confirmed direction.");
  }
  if (setup.state === "SETUP" && breakout && failedBreakout(candles, breakout.index, range, direction)) {
    setup = transitionSetup(setup, "INVALIDATED", candles[lastIndex], lastIndex, "Breakout failed and price closed back inside the compression range.");
  } else {
    setup = applyFailureAndExpiry(setup, candles, markers, settings);
  }
  return [setup];
}

function scanRangeReversals(
  input: SetupScannerInput,
  candles: Candle[],
  markers: MarketMarker[],
  zones: LiquidityZone[],
  settings: SetupScannerSettings,
): MarketSetup[] {
  if (candles.length < 12 || !["RANGING", "LIQUIDITY_GRAB", "REVERSAL_FORMING"].includes(input.context.regime.regime)) return [];
  const lastIndex = candles.length - 1;
  const base = candles.slice(Math.max(0, candles.length - 24), Math.max(0, candles.length - 3));
  if (!base.length) return [];
  const range = { high: Math.max(...base.map((c) => c.high)), low: Math.min(...base.map((c) => c.low)) };
  const recentSweeps = markers.filter(isSweep).filter((marker) => marker.confirmedAtIndex >= lastIndex - 6);
  const candidates: SetupDirection[] = [];
  if (recentSweeps.some((sweep) => sweep.direction === "BULLISH") || candles.at(-1)!.low <= range.low) candidates.push("BULLISH");
  if (recentSweeps.some((sweep) => sweep.direction === "BEARISH") || candles.at(-1)!.high >= range.high) candidates.push("BEARISH");
  return candidates.map((direction) => {
    const sweep = recentSweeps.findLast((item) => item.direction === direction) ?? null;
    const edge = direction === "BULLISH" ? range.low : range.high;
    const edgeIndex = sweep?.confirmedAtIndex ?? lastIndex;
    const matchingZone = zones
      .filter((zone) => zone.type === (direction === "BULLISH" ? "SSL" : "BSL"))
      .sort((a, b) => Math.abs(a.price - edge) - Math.abs(b.price - edge))[0] ?? null;
    const width = Math.max(input.context.volatility.atr * 0.15, (range.high - range.low) * 0.03, Number.EPSILON);
    const setupZone: SetupZone = { type: "RANGE_RETEST", minPrice: edge - width, maxPrice: edge + width, midpoint: edge, createdFrom: `range-edge:${edgeIndex}`, strength: 75, reason: `Retest zone around the completed range ${direction === "BULLISH" ? "low" : "high"}.` };
    const invalidation: SetupInvalidation = { price: direction === "BULLISH" ? edge - width : edge + width, source: "RANGE_EDGE", reason: "A strong close beyond the range edge invalidates the reversal." };
    const displacement = findAtOrAfter(markers, edgeIndex, 6, (marker): marker is MomentumMarker => marker.type === "DISPLACEMENT" && marker.direction === direction);
    const structure = findAtOrAfter(markers, edgeIndex, 8, (marker): marker is StructureMarker => isStructure(marker) && marker.direction === direction);
    const score = calculateSetupScore({ direction, context: input.context, liquidity: matchingZone, sweep, displacement, structure, locationMatch: true, psychologyMatch: psychologySupports(direction, input), setupType: "RANGE_REVERSAL" });
    const anti = antiFor(input, candles, setupZone, direction, Boolean(structure), settings);
    let setup = createSetup(input, candles, {
      id: `range-reversal:${direction}:${candles[edgeIndex].timestamp}`,
      type: "RANGE_REVERSAL",
      direction,
      createdIndex: Math.max(0, edgeIndex - 1),
      evidenceIndexes: [edgeIndex, sweep?.confirmedAtIndex, displacement?.confirmedAtIndex, structure?.confirmedAtIndex],
      liquidity: matchingZone,
      sweep,
      displacement,
      structure,
      fvg: null,
      setupZone,
      invalidation,
      score,
      anti,
      reasons: [`Price tested the completed range ${direction === "BULLISH" ? "low" : "high"}.`],
    });
    if ((sweep || rejectedRangeEdge(candles[edgeIndex], range, direction)) && psychologySupports(direction, input) && score.score >= 60) {
      setup = transitionSetup(setup, "SETUP", candles[edgeIndex], edgeIndex, "Range edge was swept or rejected and directional pressure appeared.");
    }
    if (setup.state === "SETUP" && structure && score.score >= 75 && closedInsideRange(candles[structure.confirmedAtIndex], range) && !anti.shouldAvoid) {
      setup = transitionSetup(setup, "TRIGGER", candles[structure.confirmedAtIndex], structure.confirmedAtIndex, "Price closed back inside the range with a confirmed LTF structure shift.");
    }
    return applyFailureAndExpiry(setup, candles, markers, settings);
  });
}

type CreateSetupOptions = {
  id: string;
  type: SetupType;
  direction: SetupDirection;
  createdIndex: number;
  evidenceIndexes: Array<number | null | undefined>;
  liquidity: LiquidityZone | null;
  sweep: SweepMarker | null;
  displacement: MomentumMarker | null;
  structure: StructureMarker | null;
  fvg: FvgZone | null;
  setupZone: SetupZone;
  invalidation: SetupInvalidation;
  score: ReturnType<typeof calculateSetupScore>;
  anti: AntiReversalResult;
  reasons: string[];
};

function createSetup(input: SetupScannerInput, candles: Candle[], options: CreateSetupOptions): MarketSetup {
  const createdIndex = clamp(options.createdIndex, 0, candles.length - 1);
  const target = findNearestTarget(input.context.levels, candles.at(-1)!.close, options.direction);
  return {
    id: options.id,
    type: options.type,
    direction: options.direction,
    state: "WATCH",
    createdAt: candles[createdIndex].timestamp,
    updatedAt: candles[createdIndex].timestamp,
    createdAtIndex: createdIndex,
    updatedAtIndex: createdIndex,
    sourceTimeframe: input.timeframe,
    relatedHtfContext: `${input.context.htfBias.bias} ${input.context.htfBias.strength}/100`,
    relatedItfContext: `${input.context.itfSetup.setupState} ${input.context.itfSetup.strength}/100`,
    relatedLtfCandles: uniqueIndexes(options.evidenceIndexes, candles.length),
    relatedLiquidity: options.liquidity,
    relatedSweep: options.sweep,
    relatedDisplacement: options.displacement,
    relatedStructure: options.structure,
    relatedFvg: options.fvg,
    setupZone: options.setupZone,
    invalidationLevel: options.invalidation,
    targetLiquidity: target,
    score: options.score.score,
    scoreBreakdown: options.score.breakdown,
    reasons: options.reasons,
    warnings: [...options.anti.warnings, ...sessionWarnings(input.context, options.type)],
    failedReasons: [],
    antiReversal: options.anti,
    history: [],
  };
}

function applyFailureAndExpiry(setup: MarketSetup, candles: Candle[], markers: MarketMarker[], settings: SetupScannerSettings): MarketSetup {
  if (isTerminal(setup.state)) return setup;
  const lastIndex = candles.length - 1;
  const latest = candles[lastIndex];
  const invalidatedByPrice = setup.direction === "BULLISH"
    ? latest.close < setup.invalidationLevel.price
    : setup.direction === "BEARISH"
      ? latest.close > setup.invalidationLevel.price
      : false;
  if (invalidatedByPrice) return transitionSetup(setup, "INVALIDATED", latest, lastIndex, setup.invalidationLevel.reason);
  const opposite = markers.findLast((marker) => marker.type === "DISPLACEMENT" && marker.direction !== setup.direction && marker.confirmedAtIndex > setup.updatedAtIndex);
  if (opposite && setup.state !== "TRIGGER") return transitionSetup(setup, "INVALIDATED", candles[opposite.confirmedAtIndex], opposite.confirmedAtIndex, "Strong opposite displacement invalidated the forming setup.");
  const recent = candles.slice(Math.max(0, candles.length - 14));
  const referenceAtr = setup.relatedDisplacement?.atr ?? mean(recent.map((candle) => candle.high - candle.low));
  if (setup.state === "SETUP" && referenceAtr > 0 && distanceToZone(latest.close, setup.setupZone) > referenceAtr * settings.extensionAtrMultiplier) {
    return transitionSetup(setup, "EXPIRED", latest, lastIndex, "Price moved too far from the setup zone without a valid trigger; chasing is not allowed.");
  }
  const age = lastIndex - setup.updatedAtIndex;
  if (setup.state === "WATCH" && lastIndex - setup.createdAtIndex > settings.maxWatchAgeBars) {
    return transitionSetup(setup, "INVALIDATED", latest, lastIndex, "Watch conditions did not mature within the allowed candle window.");
  }
  if ((setup.state === "SETUP" || setup.state === "TRIGGER") && age > settings.maxSetupAgeBars) {
    return transitionSetup(setup, "EXPIRED", latest, lastIndex, "Setup exceeded its allowed candle window without a fresh confirmation.");
  }
  return setup;
}

function calculateZone(input: { type: SetupType; direction: SetupDirection; candles: Candle[]; liquidity: LiquidityZone | null; displacement: MomentumMarker | null; fvg: FvgZone | null; anchorIndex: number }): SetupZone {
  if (input.fvg) return zone("FVG", input.fvg.minPrice, input.fvg.maxPrice, input.fvg.id, input.fvg.strength * 30, "Unmitigated imbalance created by confirmed displacement.");
  if (input.liquidity && input.type === "LIQUIDITY_SWEEP_REVERSAL") return zone("SWEPT_LIQUIDITY_RETEST", input.liquidity.minPrice, input.liquidity.maxPrice, input.liquidity.id, input.liquidity.strength * 30, "Retest band around swept liquidity.");
  if (input.displacement) {
    const candle = input.candles[input.displacement.confirmedAtIndex];
    const midpoint = (candle.open + candle.close) / 2;
    const half = Math.max(Math.abs(candle.close - candle.open) * 0.12, Number.EPSILON);
    return zone("DISPLACEMENT_50", midpoint - half, midpoint + half, input.displacement.id, 75, "Fifty-percent retracement band of the displacement body.");
  }
  const opposite = findLastOppositeCandle(input.candles, input.direction, input.anchorIndex);
  if (opposite) return zone("ORDER_BLOCK_LIKE", opposite.low, opposite.high, `candle:${opposite.timestamp}`, 60, "Last opposite closed candle before the directional attempt; treated as order-block-like context only.");
  const anchor = input.candles[clamp(input.anchorIndex, 0, input.candles.length - 1)];
  return zone("PREMIUM_DISCOUNT", Math.min(anchor.open, anchor.close), Math.max(anchor.open, anchor.close), `candle:${anchor.timestamp}`, 45, "Completed candle body supplies a conservative contextual zone.");
}

function antiFor(input: SetupScannerInput, candles: Candle[], setupZone: SetupZone, direction: SetupDirection, hasFollowThrough: boolean, settings: SetupScannerSettings): AntiReversalResult {
  const latest = candles.at(-1)!;
  const range = latest.high - latest.low;
  return evaluateAntiReversal({
    direction,
    zone: setupZone,
    currentPrice: latest.close,
    atr: input.context.volatility.atr,
    context: input.context,
    reversalRisk: input.candleReading?.reversalWarning.reversalRisk,
    latestBodyRatio: range > 0 ? Math.abs(latest.close - latest.open) / range : 0,
    hasFollowThrough,
    extensionAtrMultiplier: settings.extensionAtrMultiplier,
  });
}

function invalidationForSweep(direction: SetupDirection, sweep: SweepMarker): SetupInvalidation {
  return {
    price: sweep.sweepPrice,
    source: "SWEEP_EXTREME",
    reason: `${directionLabel(direction)} sweep reversal fails on a close beyond the sweep extreme.`,
  };
}

function findCompressionBreakout(candles: Candle[]): { index: number; direction: "BULLISH" | "BEARISH"; range: { high: number; low: number }; extended: boolean } | null {
  for (let index = Math.max(8, candles.length - 7); index < candles.length; index += 1) {
    const prior = candles.slice(index - 8, index);
    if (!isCompressed(prior)) continue;
    const range = { high: Math.max(...prior.map((c) => c.high)), low: Math.min(...prior.map((c) => c.low)) };
    const candle = candles[index];
    const averageRange = mean(prior.map((item) => item.high - item.low));
    if (candle.close > range.high) return { index, direction: "BULLISH", range, extended: candle.close - range.high > averageRange * 1.5 };
    if (candle.close < range.low) return { index, direction: "BEARISH", range, extended: range.low - candle.close > averageRange * 1.5 };
  }
  return null;
}

function compressionRange(candles: Candle[]): { high: number; low: number } | null {
  if (!candles.length) return null;
  return { high: Math.max(...candles.map((c) => c.high)), low: Math.min(...candles.map((c) => c.low)) };
}

function isCompressed(candles: Candle[]): boolean {
  if (candles.length < 6) return false;
  const ranges = candles.map((c) => c.high - c.low);
  const half = Math.floor(ranges.length / 2);
  const narrowing = mean(ranges.slice(half)) <= mean(ranges.slice(0, half)) * 0.85;
  let overlap = 0;
  let inside = 0;
  for (let index = 1; index < candles.length; index += 1) {
    if (candles[index].low <= candles[index - 1].high && candles[index].high >= candles[index - 1].low) overlap += 1;
    if (candles[index].high <= candles[index - 1].high && candles[index].low >= candles[index - 1].low) inside += 1;
  }
  return narrowing && (overlap / (candles.length - 1) >= 0.7 || inside >= 2);
}

function findBreakoutRetest(candles: Candle[], breakoutIndex: number, range: { high: number; low: number }, direction: SetupDirection): number | null {
  for (let index = breakoutIndex + 1; index < candles.length - 1 && index <= breakoutIndex + 6; index += 1) {
    const retest = candles[index];
    const follow = candles[index + 1];
    if (direction === "BULLISH" && retest.low <= range.high && retest.close >= range.high && follow.close > retest.high) return index + 1;
    if (direction === "BEARISH" && retest.high >= range.low && retest.close <= range.low && follow.close < retest.low) return index + 1;
  }
  return null;
}

function failedBreakout(candles: Candle[], breakoutIndex: number, range: { high: number; low: number }, direction: SetupDirection): boolean {
  return candles.slice(breakoutIndex + 1).some((candle) => direction === "BULLISH" ? candle.close < range.high : candle.close > range.low);
}

function findPullbackIndex(candles: Candle[], direction: SetupDirection, start: number, end: number): number | null {
  for (let index = end; index >= start; index -= 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    if (direction === "BULLISH" && candle.low < previous.low && candle.close <= candle.open) return index;
    if (direction === "BEARISH" && candle.high > previous.high && candle.close >= candle.open) return index;
  }
  return null;
}

function findZoneTouch(candles: Candle[], zoneValue: SetupZone, from: number, to: number, invalidation: SetupInvalidation, direction: SetupDirection): number | null {
  for (let index = Math.max(0, from); index <= to; index += 1) {
    const candle = candles[index];
    const touches = candle.low <= zoneValue.maxPrice && candle.high >= zoneValue.minPrice;
    const holds = direction === "BULLISH" ? candle.close > invalidation.price : candle.close < invalidation.price;
    if (touches && holds) return index;
  }
  return null;
}

function findAfter<T extends MarketMarker>(markers: MarketMarker[], index: number, maxBars: number, predicate: (marker: MarketMarker) => marker is T): T | null {
  return markers.find((marker): marker is T => marker.confirmedAtIndex > index && marker.confirmedAtIndex <= index + maxBars && predicate(marker)) ?? null;
}

function findAtOrAfter<T extends MarketMarker>(markers: MarketMarker[], index: number, maxBars: number, predicate: (marker: MarketMarker) => marker is T): T | null {
  return markers.find((marker): marker is T => marker.confirmedAtIndex >= index && marker.confirmedAtIndex <= index + maxBars && predicate(marker)) ?? null;
}

function findRelatedFvg(markers: MarketMarker[], index: number, direction: SetupDirection): FvgZone | null {
  return markers.find((marker): marker is FvgZone => marker.type === "FVG" && marker.direction === direction && marker.confirmedAtIndex >= index && marker.confirmedAtIndex <= index + 3) ?? null;
}

function findBestFvg(markers: MarketMarker[], direction: SetupDirection, index: number): FvgZone | null {
  return markers.findLast((marker): marker is FvgZone => marker.type === "FVG" && marker.direction === direction && marker.confirmedAtIndex <= index && !marker.mitigated) ?? null;
}

function findLastOppositeCandle(candles: Candle[], direction: SetupDirection, anchor: number): Candle | null {
  for (let index = Math.min(anchor, candles.length - 1); index >= Math.max(0, anchor - 5); index -= 1) {
    const bullish = candles[index].close > candles[index].open;
    if ((direction === "BULLISH" && !bullish) || (direction === "BEARISH" && bullish)) return candles[index];
  }
  return null;
}

function nearestDirectionalLevel(context: MarketContextResult, direction: SetupDirection): KeyLevel | null {
  return direction === "BULLISH" ? context.nearestLevels.nearestSupport : direction === "BEARISH" ? context.nearestLevels.nearestResistance : null;
}

function psychologySupports(direction: SetupDirection, input: SetupScannerInput): boolean {
  const reading = input.candleReading;
  if (!reading || direction === "NEUTRAL") return false;
  return direction === "BULLISH"
    ? reading.sequence.pressure === "BUYERS_ACTIVE" || reading.scenarios.expectedBias === "BULLISH" || reading.sequence.features.some((item) => item.toLowerCase().includes("bullish") || item.toLowerCase().includes("reversal attempt"))
    : reading.sequence.pressure === "SELLERS_ACTIVE" || reading.scenarios.expectedBias === "BEARISH" || reading.sequence.features.some((item) => item.toLowerCase().includes("bearish") || item.toLowerCase().includes("reversal attempt"));
}

function isLocationAligned(direction: SetupDirection, context: MarketContextResult): boolean {
  const location = context.premiumDiscount?.zone;
  if (!location) return true;
  return direction === "BULLISH" ? location === "DISCOUNT" || location === "DEEP_DISCOUNT" : direction === "BEARISH" ? location === "PREMIUM" || location === "DEEP_PREMIUM" : false;
}

function sessionWarnings(context: MarketContextResult, type: SetupType): string[] {
  const warnings: string[] = [];
  if (context.session.session === "ASIAN" && type === "COMPRESSION_BREAKOUT" && context.volatility.state === "LOW_VOLATILITY") warnings.push("Asian breakout confidence stays reduced until volatility expands.");
  if (context.session.session === "DEAD_ZONE") warnings.push("WAIT: weak session participation reduces setup quality.");
  if (context.session.session.includes("NEW_YORK") && context.volatility.state === "EXTREME_VOLATILITY") warnings.push("New York extreme volatility may reflect news-like conditions.");
  return warnings;
}

function rejectedRangeEdge(candle: Candle, range: { high: number; low: number }, direction: SetupDirection): boolean {
  return direction === "BULLISH" ? candle.low <= range.low && candle.close > range.low : candle.high >= range.high && candle.close < range.high;
}

function closedInsideRange(candle: Candle, range: { high: number; low: number }): boolean {
  return candle.close > range.low && candle.close < range.high;
}

function zoneTouched(candle: Candle, target: SetupZone): boolean {
  return candle.low <= target.maxPrice && candle.high >= target.minPrice;
}

function zone(type: SetupZone["type"], minPrice: number, maxPrice: number, createdFrom: string, strength: number, reason: string): SetupZone {
  const min = Math.min(minPrice, maxPrice);
  const max = Math.max(minPrice, maxPrice);
  return { type, minPrice: min, maxPrice: max, midpoint: (min + max) / 2, createdFrom, strength: clamp(strength, 0, 100), reason };
}

function distanceToZone(price: number, target: SetupZone): number {
  if (price < target.minPrice) return target.minPrice - price;
  if (price > target.maxPrice) return price - target.maxPrice;
  return 0;
}

function isSweep(marker: MarketMarker): marker is SweepMarker {
  return marker.type === "SSL_SWEEP" || marker.type === "BSL_SWEEP";
}

function isStructure(marker: MarketMarker): marker is StructureMarker {
  return marker.type === "BOS" || marker.type === "CHOCH" || marker.type === "MSS";
}

function rememberSetup(map: Map<string, MarketSetup>, list: MarketSetup[], setup: MarketSetup): void {
  const existing = map.get(setup.id);
  if (!existing || compareSetups(setup, existing) < 0) {
    map.set(setup.id, setup);
    if (existing) list.splice(list.indexOf(existing), 1);
    list.push(setup);
  }
}

function compareSetups(a: MarketSetup, b: MarketSetup): number {
  const stateRank: Record<SetupState, number> = { TRIGGER: 5, SETUP: 4, WATCH: 3, INVALIDATED: 2, EXPIRED: 1 };
  return stateRank[b.state] - stateRank[a.state] || b.score - a.score || b.updatedAt - a.updatedAt;
}

function uniqueIndexes(indexes: Array<number | null | undefined>, length: number): number[] {
  return [...new Set(indexes.filter((index): index is number => typeof index === "number" && index >= 0 && index < length))].sort((a, b) => a - b);
}

function evidenceIsCausal(setup: MarketSetup, lastIndex: number): boolean {
  const triggerIndex = setup.history.find((item) => item.to === "TRIGGER")?.candleIndex;
  const evidenceLimit = triggerIndex ?? lastIndex;
  const markerIndexes = [
    setup.relatedLiquidity?.confirmedAtIndex,
    setup.relatedSweep?.confirmedAtIndex,
    setup.relatedDisplacement?.confirmedAtIndex,
    setup.relatedStructure?.confirmedAtIndex,
    setup.relatedFvg?.confirmedAtIndex,
  ].filter((index): index is number => typeof index === "number");

  return setup.relatedLtfCandles.every((index) => index <= evidenceLimit) &&
    markerIndexes.every((index) => index <= evidenceLimit) &&
    setup.history.every((item) => item.candleIndex <= lastIndex);
}

function buildCacheKey(input: SetupScannerInput, candles: Candle[], settings: SetupScannerSettings): string {
  const last = candles.at(-1);
  return [input.symbol, input.timeframe, input.startDate, input.endDate, candles.length, last?.timestamp ?? 0, last?.close ?? 0, input.structure.markers.length, JSON.stringify(settings)].join(":");
}

function cloneResult(result: SetupScannerResult, cacheStatus: "hit" | "miss"): SetupScannerResult {
  return { ...result, setupMap: new Map(result.setupMap), audit: { ...result.audit, cacheStatus } };
}

function emptyResult(duration: number): SetupScannerResult {
  return {
    setups: [], activeSetups: [], invalidatedSetups: [], expiredSetups: [], setupMap: new Map(),
    audit: { processedCandles: 0, currentCandleIndex: -1, activeSetupCount: 0, watchCount: 0, setupCount: 0, triggerCount: 0, invalidatedCount: 0, expiredCount: 0, transitionCount: 0, calculationTimeMs: duration, cacheStatus: "miss", noFutureValidation: "pass" },
  };
}

function lowerBound(levels: KeyLevel[], price: number): number {
  let low = 0;
  let high = levels.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (levels[middle].price < price) low = middle + 1;
    else high = middle;
  }
  return low;
}

function directionLabel(direction: SetupDirection): string {
  return direction.charAt(0) + direction.slice(1).toLowerCase();
}

function isTerminal(state: SetupState): boolean {
  return state === "INVALIDATED" || state === "EXPIRED";
}

function mean(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
