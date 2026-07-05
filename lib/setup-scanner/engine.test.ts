import { describe, expect, it } from "vitest";

import type { Candle } from "../candles/types";
import type { CandleReadingResult } from "../candle-reading/types";
import type { MarketContextResult } from "../market-context/types";
import type {
  LiquidityZone,
  MarketStructureResult,
  MomentumMarker,
  StructureMarker,
  SweepMarker,
} from "../market-structure/types";
import {
  calculateSetupScore,
  clearSetupScannerCache,
  evaluateAntiReversal,
  findNearestTarget,
  scanSetups,
  transitionSetup,
} from "./engine";
import type { MarketSetup, SetupZone } from "./types";

describe("setup lifecycle state machine", () => {
  it("creates WATCH and moves WATCH to SETUP with a reason", () => {
    const setup = baseSetup();
    const next = transitionSetup(setup, "SETUP", candle(2), 2, "evidence matured");
    expect(setup.state).toBe("WATCH");
    expect(next.state).toBe("SETUP");
    expect(next.history[0]).toMatchObject({ from: "WATCH", to: "SETUP", candleIndex: 2, reason: "evidence matured" });
  });

  it("moves SETUP to TRIGGER only through the legal path", () => {
    const watch = baseSetup();
    expect(transitionSetup(watch, "TRIGGER", candle(2), 2, "illegal")).toBe(watch);
    const setup = transitionSetup(watch, "SETUP", candle(2), 2, "setup");
    expect(transitionSetup(setup, "TRIGGER", candle(3), 3, "trigger").state).toBe("TRIGGER");
  });

  it("moves SETUP to INVALIDATED", () => {
    const setup = transitionSetup(baseSetup(), "SETUP", candle(2), 2, "setup");
    const failed = transitionSetup(setup, "INVALIDATED", candle(3), 3, "structure broke");
    expect(failed.state).toBe("INVALIDATED");
    expect(failed.failedReasons).toContain("structure broke");
  });

  it("moves SETUP to EXPIRED", () => {
    const setup = transitionSetup(baseSetup(), "SETUP", candle(2), 2, "setup");
    expect(transitionSetup(setup, "EXPIRED", candle(15), 15, "timeout").state).toBe("EXPIRED");
  });

  it("allows TRIGGER to expire but never emits a BUY or SELL state", () => {
    const setup = transitionSetup(baseSetup(), "SETUP", candle(2), 2, "setup");
    const trigger = transitionSetup(setup, "TRIGGER", candle(3), 3, "trigger");
    const expired = transitionSetup(trigger, "EXPIRED", candle(20), 20, "stale");
    expect(expired.state).toBe("EXPIRED");
    expect(JSON.stringify(expired)).not.toMatch(/"state":"(BUY|SELL)"/);
  });
});

describe("liquidity sweep reversal scanner", () => {
  it("builds a bullish sweep reversal through WATCH, SETUP, and TRIGGER", () => {
    const result = sweepScenario("BULLISH");
    const setup = result.setups.find((item) => item.type === "LIQUIDITY_SWEEP_REVERSAL");
    expect(setup?.direction).toBe("BULLISH");
    expect(setup?.history.map((item) => item.to)).toEqual(["SETUP", "TRIGGER"]);
  });

  it("builds a bearish sweep reversal", () => {
    const result = sweepScenario("BEARISH");
    const setup = result.setups.find((item) => item.type === "LIQUIDITY_SWEEP_REVERSAL");
    expect(setup?.direction).toBe("BEARISH");
    expect(setup?.score).toBeGreaterThanOrEqual(75);
  });

  it("invalidates a sweep setup when a later close fails beyond its sweep extreme", () => {
    const setup = transitionSetup(baseSetup(), "SETUP", candle(5), 5, "sweep held");
    const failed = transitionSetup(setup, "INVALIDATED", candle(6), 6, setup.invalidationLevel.reason);
    expect(failed.failedReasons.at(-1)).toContain("sweep");
  });
});

describe("trend continuation scanner", () => {
  it.each(["BULLISH", "BEARISH"] as const)("detects a %s continuation after a pullback", (direction) => {
    const candles = directionalPullback(direction);
    const markers = [displacement(direction, candles, 10), structureMarker(direction, candles, 11)];
    const result = scanSetups(scannerInput(candles, structureResult(candles, markers), context(direction), reading(direction)));
    const setup = result.setups.find((item) => item.type === "TREND_CONTINUATION" && item.direction === direction);
    expect(setup).toBeDefined();
    expect(setup?.setupZone.type).toMatch(/ORDER_BLOCK_LIKE|DISPLACEMENT_50|FVG/);
  });

  it("detects a pullback zone from the last opposite candle", () => {
    const candles = directionalPullback("BULLISH");
    const result = scanSetups(scannerInput(candles, structureResult(candles), context("BULLISH"), reading("BULLISH")));
    expect(result.setups.find((item) => item.type === "TREND_CONTINUATION")?.setupZone.createdFrom).toContain("candle:");
  });

  it("records continuation invalidation after a structure break", () => {
    const setup = transitionSetup(baseSetup("TREND_CONTINUATION"), "SETUP", candle(5), 5, "pullback");
    const failed = transitionSetup(setup, "INVALIDATED", candle(6), 6, "Opposite CHOCH broke pullback structure.");
    expect(failed.state).toBe("INVALIDATED");
  });
});

describe("compression breakout scanner", () => {
  it("creates a compression WATCH before breakout confirmation", () => {
    const candles = compressedCandles();
    const result = scanSetups(scannerInput(candles, structureResult(candles), context("BULLISH", "COMPRESSION"), reading("BULLISH")));
    expect(result.setups.find((item) => item.type === "COMPRESSION_BREAKOUT")?.state).toBe("WATCH");
  });

  it("moves a displacement breakout to SETUP", () => {
    const candles = [...compressedCandles(), candleValues(8, 100.3, 101.5, 100.2, 101.3)];
    const markers = [displacement("BULLISH", candles, 8)];
    const result = scanSetups(scannerInput(candles, structureResult(candles, markers), context("BULLISH", "COMPRESSION"), reading("BULLISH")));
    expect(result.setups.find((item) => item.type === "COMPRESSION_BREAKOUT")?.state).toBe("SETUP");
  });

  it("moves a breakout retest and follow-through to TRIGGER", () => {
    const candles = [
      ...compressedCandles(),
      candleValues(8, 100.3, 101.5, 100.2, 101.3),
      candleValues(9, 101.2, 101.35, 100.55, 101.1),
      candleValues(10, 101.1, 101.8, 101, 101.7),
    ];
    const result = scanSetups(scannerInput(candles, structureResult(candles, [displacement("BULLISH", candles, 8)]), context("BULLISH", "COMPRESSION"), reading("BULLISH")));
    expect(result.setups.find((item) => item.type === "COMPRESSION_BREAKOUT")?.state).toBe("TRIGGER");
  });

  it("invalidates a failed breakout that closes back inside", () => {
    const candles = [...compressedCandles(), candleValues(8, 100.3, 101.5, 100.2, 101.3), candleValues(9, 101.2, 101.25, 100.2, 100.4)];
    const result = scanSetups(scannerInput(candles, structureResult(candles, [displacement("BULLISH", candles, 8)]), context("BULLISH", "COMPRESSION"), reading("BULLISH")));
    expect(result.setups.find((item) => item.type === "COMPRESSION_BREAKOUT")?.state).toBe("INVALIDATED");
  });
});

describe("range reversal scanner", () => {
  it.each(["BULLISH", "BEARISH"] as const)("detects a %s range-edge reversal", (direction) => {
    const scenario = rangeScenario(direction);
    const result = scanSetups(scannerInput(scenario.candles, scenario.structure, context(direction, "RANGING"), reading(direction)));
    const setup = result.setups.find((item) => item.type === "RANGE_REVERSAL" && item.direction === direction);
    expect(setup).toBeDefined();
    expect(setup?.setupZone.type).toBe("RANGE_RETEST");
  });

  it("supports explicit range-break invalidation", () => {
    const setup = transitionSetup(baseSetup("RANGE_REVERSAL"), "SETUP", candle(4), 4, "range rejection");
    expect(transitionSetup(setup, "INVALIDATED", candle(5), 5, "Strong close beyond range low.").state).toBe("INVALIDATED");
  });
});

describe("setup scoring, filters, and targets", () => {
  it("keeps weak evidence below the valid setup band", () => {
    const scored = calculateSetupScore({ direction: "BULLISH", context: context("BEARISH", "CHOPPY", true), setupType: "TREND_CONTINUATION" });
    expect(scored.score).toBeLessThan(60);
  });

  it("scores complete evidence as valid and strong", () => {
    const fixture = scoringEvidence("BULLISH");
    const scored = calculateSetupScore(fixture);
    expect(scored.score).toBeGreaterThanOrEqual(75);
    expect(scored.score).toBeLessThanOrEqual(100);
  });

  it("applies the preferred London session adjustment to sweep reversals", () => {
    const london = context("BULLISH");
    london.session.session = "LONDON";
    const asian = context("BULLISH");
    asian.session.session = "ASIAN";
    expect(calculateSetupScore({ ...scoringEvidence("BULLISH"), context: london }).breakdown.sessionQuality)
      .toBeGreaterThanOrEqual(calculateSetupScore({ ...scoringEvidence("BULLISH"), context: asian }).breakdown.sessionQuality);
  });

  it("raises reversal risk for extension, chop, extreme volatility, and HTF opposition", () => {
    const risky = context("BEARISH", "CHOPPY", true);
    const result = evaluateAntiReversal({ direction: "BULLISH", zone: setupZone(), currentPrice: 120, atr: 1, context: risky, reversalRisk: "HIGH", latestBodyRatio: 0.1, hasFollowThrough: false });
    expect(result.reversalRisk).toBe("HIGH");
    expect(result.shouldAvoid).toBe(true);
  });

  it("uses sorted levels and binary search to find directional target liquidity", () => {
    const levels = context("BULLISH").levels;
    expect(findNearestTarget(levels, 100, "BULLISH")?.price).toBe(105);
    expect(findNearestTarget(levels, 100, "BEARISH")?.price).toBe(95);
  });
});

describe("replay, cache, and no-future behavior", () => {
  it("does not show a setup before its related marker confirmation", () => {
    const full = bullishSweepCandles();
    const futureMarkers = sweepMarkers("BULLISH", full);
    const partial = full.slice(0, 5);
    const result = scanSetups(scannerInput(partial, structureResult(partial, futureMarkers, [liquidity("SSL", 99, 1, 5)]), context("BULLISH"), reading("BULLISH")));
    expect(result.setups.some((item) => item.type === "LIQUIDITY_SWEEP_REVERSAL")).toBe(false);
    expect(result.audit.noFutureValidation).toBe("pass");
  });

  it("limits every transition and related candle to the current replay index", () => {
    const result = sweepScenario("BULLISH");
    expect(result.setups.every((setup) => [...setup.relatedLtfCandles, ...setup.history.map((item) => item.candleIndex)].every((index) => index <= result.audit.currentCandleIndex))).toBe(true);
  });

  it("uses only closed candles and returns cache hits for identical scanner inputs", () => {
    clearSetupScannerCache();
    const candles = directionalPullback("BULLISH");
    candles.push({ ...candle(20), isClosed: false });
    const input = scannerInput(candles, structureResult(candles), context("BULLISH"), reading("BULLISH"));
    expect(scanSetups(input).audit.processedCandles).toBe(candles.length - 1);
    expect(scanSetups(input).audit.cacheStatus).toBe("hit");
  });

  it("does not include diagnostic context cache status in the scanner cache key", () => {
    clearSetupScannerCache();
    const candles = directionalPullback("BULLISH");
    const input = scannerInput(candles, structureResult(candles), context("BULLISH"), reading("BULLISH"));
    expect(scanSetups(input).audit.cacheStatus).toBe("miss");
    expect(scanSetups({ ...input, context: { ...input.context, cacheStatus: "hit" } }).audit.cacheStatus).toBe("hit");
  });
});

function sweepScenario(direction: "BULLISH" | "BEARISH") {
  const candles = direction === "BULLISH" ? bullishSweepCandles() : bearishSweepCandles();
  const markers = sweepMarkers(direction, candles);
  const zone = liquidity(direction === "BULLISH" ? "SSL" : "BSL", direction === "BULLISH" ? 99 : 101, 1, 5);
  return scanSetups(scannerInput(candles, structureResult(candles, markers, [zone]), context(direction), reading(direction)));
}

function bullishSweepCandles(): Candle[] {
  return [candleValues(0, 100, 100.5, 99.5, 100.1), candleValues(1, 100.1, 100.4, 99, 99.6), candleValues(2, 99.6, 100.2, 99.2, 100), candleValues(3, 100, 100.4, 99.4, 99.8), candleValues(4, 99.8, 100.1, 99.2, 99.5), candleValues(5, 99.5, 100.2, 98.5, 99.8), candleValues(6, 99.8, 101.2, 99.7, 101), candleValues(7, 101, 101.5, 100.5, 101.3), candleValues(8, 100.9, 101.1, 98.95, 99.7), candleValues(9, 99.7, 101.3, 99.5, 101.1)];
}

function bearishSweepCandles(): Candle[] {
  return bullishSweepCandles().map((item) => ({ ...item, open: 200 - item.open, high: 200 - item.low, low: 200 - item.high, close: 200 - item.close }));
}

function sweepMarkers(direction: "BULLISH" | "BEARISH", candles: Candle[]): Array<SweepMarker | MomentumMarker | StructureMarker> {
  const type = direction === "BULLISH" ? "SSL_SWEEP" : "BSL_SWEEP";
  const sweep: SweepMarker = { id: "sweep", type, timestamp: candles[5].timestamp, price: candles[5].close, direction, strength: 3, reason: "clean wick sweep and rejection", confirmedAtIndex: 5, confirmedAtTimestamp: candles[5].timestamp, sourceIndexes: [1, 5], sweptLiquidityId: "liquidity", sweepIndex: 5, sweepPrice: direction === "BULLISH" ? candles[5].low : candles[5].high, closePrice: candles[5].close, rejectionStrength: 0.8, atrDistance: 0.5, sweepKind: "WICK_SWEEP" };
  return [sweep, displacement(direction, candles, 6), structureMarker(direction, candles, 7)];
}

function rangeScenario(direction: "BULLISH" | "BEARISH") {
  const base = Array.from({ length: 12 }, (_, index) => candleValues(index, 100, 101, 99, index % 2 ? 100.4 : 99.6));
  base[11] = direction === "BULLISH" ? candleValues(11, 99.5, 100.4, 98.5, 100.2) : candleValues(11, 100.5, 101.5, 99.6, 99.8);
  const zone = liquidity(direction === "BULLISH" ? "SSL" : "BSL", direction === "BULLISH" ? 99 : 101, 1, 11);
  const sweep = sweepMarkers(direction, [...base.slice(0, 5), ...base.slice(5)])[0] as SweepMarker;
  sweep.confirmedAtIndex = 11; sweep.confirmedAtTimestamp = base[11].timestamp; sweep.timestamp = base[11].timestamp; sweep.sweptLiquidityId = zone.id;
  return { candles: base, structure: structureResult(base, [sweep], [zone]) };
}

function directionalPullback(direction: "BULLISH" | "BEARISH"): Candle[] {
  return Array.from({ length: 14 }, (_, index) => {
    const base = direction === "BULLISH" ? 100 + index * 0.4 : 106 - index * 0.4;
    if (index === 9) return direction === "BULLISH" ? candleValues(index, base, base + 0.2, base - 1.4, base - 0.8) : candleValues(index, base, base + 1.4, base - 0.2, base + 0.8);
    return direction === "BULLISH" ? candleValues(index, base, base + 0.7, base - 0.2, base + 0.5) : candleValues(index, base, base + 0.2, base - 0.7, base - 0.5);
  });
}

function compressedCandles(): Candle[] {
  return Array.from({ length: 8 }, (_, index) => {
    const range = 1.2 - index * 0.1;
    return candleValues(index, 100, 100 + range / 2, 100 - range / 2, 100 + (index % 2 ? 0.05 : -0.05));
  });
}

function scannerInput(candles: Candle[], structure: MarketStructureResult, marketContext: MarketContextResult, candleReading: CandleReadingResult) {
  return { candles, symbol: "XAUUSD", timeframe: "1m" as const, startDate: "2026-05-20", endDate: "2026-05-21", structure, context: marketContext, candleReading };
}

function context(direction: "BULLISH" | "BEARISH", regime: MarketContextResult["regime"]["regime"] = "TRENDING_BULLISH", risky = false): MarketContextResult {
  const bullish = direction === "BULLISH";
  const levels = [
    { id: "ssl", type: "SSL" as const, timeframe: "LTF" as const, price: 95, minPrice: 94.9, maxPrice: 95.1, strength: 85, touchedCount: 2, lastTouchedAt: 1, swept: false, distanceFromCurrentPrice: 5, reason: "support liquidity" },
    { id: "bsl", type: "BSL" as const, timeframe: "LTF" as const, price: 105, minPrice: 104.9, maxPrice: 105.1, strength: 85, touchedCount: 2, lastTouchedAt: 1, swept: false, distanceFromCurrentPrice: 5, reason: "target liquidity" },
  ];
  return {
    mapping: { ltf: "1m", itf: "5m", htf: "15m", modeName: "1M SCALPING" }, itfCandles: [], htfCandles: [],
    htfBias: { bias: direction, strength: risky ? 90 : 100, structureState: direction, lastBos: "bos", lastChoch: null, majorSwingHigh: 110, majorSwingLow: 90, reason: "test bias", warnings: [] },
    itfSetup: { setupState: "READY_FOR_LTF_TRIGGER", direction, strength: 100, relatedLiquidity: "liquidity", relatedSweep: "sweep", relatedDisplacement: "disp", relatedStructure: "mss", pullbackZone: { minPrice: 99, maxPrice: 101 }, reason: "test", invalidation: bullish ? 98 : 102 },
    premiumDiscount: { rangeHigh: 110, rangeLow: 90, equilibrium: 100, currentPositionPercent: bullish ? 25 : 75, zone: bullish ? "DISCOUNT" : "PREMIUM", buyQuality: bullish ? 100 : 20, sellQuality: bullish ? 20 : 100, reason: "good location" },
    levels,
    nearestLevels: { nearestResistance: levels[1], nearestSupport: levels[0], nearestBSL: levels[1], nearestSSL: levels[0], distanceToResistance: 5, distanceToSupport: 5 },
    regime: { regime, confidence: 90, trendQuality: 90, rangeQuality: regime === "RANGING" ? 90 : 20, volatilityQuality: risky ? 10 : 90, chopRisk: risky ? 90 : 10, reason: "test", warnings: [] },
    session: { session: "LONDON", displayTimezone: "UTC", sessionQuality: risky ? 20 : 90, sessionOpen: 1, sessionClose: 2, currentSessionHigh: 105, currentSessionLow: 95, previousSessionHigh: 104, previousSessionLow: 96, sessionBias: direction, reason: "test" },
    volatility: { state: risky ? "EXTREME_VOLATILITY" : "NORMAL_VOLATILITY", atr: 1, atrPercentile: 50, averageRange: 1, expansionRatio: 1, warning: risky ? "extreme" : null, reason: "test" },
    score: { overallScore: risky ? 20 : 90, directionPreference: direction, tradeEnvironment: risky ? "POOR" : "GOOD", reason: "test", warnings: [] },
    wait: { shouldWait: risky, waitReasons: [], requiredForImprovement: [] }, cacheStatus: "miss",
  };
}

function reading(direction: "BULLISH" | "BEARISH"): CandleReadingResult {
  const bullish = direction === "BULLISH";
  return { analyzedCandleCount: 10, windowStartTimestamp: 0, windowEndTimestamp: 10, marketMood: direction, latestCandle: { index: 9, sequenceNumber: 10, timestamp: 10, time: "", open: 100, high: 101, low: 99, close: bullish ? 100.8 : 99.2, volume: 1, bodySize: 0.8, rangeSize: 2, upperWick: 0.2, lowerWick: 0.2, closePosition: bullish ? 0.9 : 0.1, bodyRangeRatio: 0.4, atr: 1, atrRatio: 1, direction, primaryType: bullish ? "STRONG_BULLISH" : "STRONG_BEARISH", classifications: [], control: bullish ? "BUYERS" : "SELLERS", closeStrength: "STRONG", rejection: bullish ? "LOW" : "HIGH", relationToPrevious: "test", volumeContext: "test", explanation: "test" }, candles: [], sequence: { shortTermFlow: direction, momentumState: "INCREASING", volatilityState: "NORMAL", pressure: bullish ? "BUYERS_ACTIVE" : "SELLERS_ACTIVE", features: [`${direction.toLowerCase()} reversal attempt`], reason: "test" }, questions: { lastCandleControl: "", closeQuality: "", rejection: "", volatility: "", momentum: "", breakoutTrap: "", liquiditySweep: "", extensionRisk: "", nextCandleExpectation: "", bullishConfirmation: "", bearishConfirmation: "", currentReadInvalidation: "" }, scenarios: { expectedBias: direction, bullishScenario: { probability: 70, condition: "", expectedBehavior: "", invalidation: 0 }, bearishScenario: { probability: 20, condition: "", expectedBehavior: "", invalidation: 0 }, neutralScenario: { probability: 10, condition: "", expectedBehavior: "", invalidation: 0 }, confidence: 8, warning: "" }, reversalWarning: { reversalRisk: "LOW", reasons: [], avoidChasing: false }, scores: { latestCandle: { total: 8, label: "STRONG", components: {} }, sequence: { total: 8, label: "STRONG", components: {} }, confidence: { score: 8, label: "STRONG" } }, keyLevels: { previousHigh: 101, previousLow: 99, previousMidpoint: 100, latestClose: 100, bullishInvalidation: 99, bearishInvalidation: 101 }, humanSummary: "test" };
}

function scoringEvidence(direction: "BULLISH" | "BEARISH") {
  const candles = bullishSweepCandles();
  const zoneValue = liquidity(direction === "BULLISH" ? "SSL" : "BSL", direction === "BULLISH" ? 99 : 101, 1, 5);
  const markers = sweepMarkers(direction, candles);
  return { direction, context: context(direction), liquidity: zoneValue, sweep: markers[0] as SweepMarker, displacement: markers[1] as MomentumMarker, structure: markers[2] as StructureMarker, locationMatch: true, psychologyMatch: true, setupType: "LIQUIDITY_SWEEP_REVERSAL" as const };
}

function structureResult(candles: Candle[], markers: MarketStructureResult["markers"] = [], zones: LiquidityZone[] = []): MarketStructureResult {
  return { candles, markers, markerMap: new Map(markers.map((item) => [item.id, item])), liquidityZones: zones, liquidityZoneMap: new Map(zones.map((item) => [item.id, item])), fvgZones: [], atr: candles.map(() => 1), audit: { totalCandles: candles.length, totalSwingHighs: 0, totalSwingLows: 0, totalBslZones: 0, totalSslZones: 0, totalEqualHighZones: 0, totalEqualLowZones: 0, totalSweeps: 0, totalSslSweeps: 0, totalBslSweeps: 0, totalMomentumCandles: 0, totalBullishMomentum: 0, totalBearishMomentum: 0, totalBuyersMarkers: 0, totalSellersMarkers: 0, totalBos: 0, totalChoch: 0, totalMss: 0, totalFvg: 0, totalMitigatedFvg: 0, calculationTimeMs: 0, lastMarkerCreated: null, currentStructureState: "RANGING", markerSensitivitySettings: { sensitivity: "normal", leftBars: 2, rightBars: 2, atrPeriod: 14, showOnlyMajor: false }, cacheStatus: "miss", validationWarnings: [], noRepaintValidationStatus: "pass" } };
}

function liquidity(type: "BSL" | "SSL", price: number, confirmedAtIndex: number, sweptAtIndex: number): LiquidityZone {
  return { id: "liquidity", type, price, minPrice: price - 0.1, maxPrice: price + 0.1, startIndex: 0, endIndex: 1, timestamp: candle(1).timestamp, strength: 3, touches: 2, swept: true, sweptAt: candle(sweptAtIndex).timestamp, sweptAtIndex, reason: "equal liquidity", confirmedAtIndex, confirmedAtTimestamp: candle(confirmedAtIndex).timestamp, sourceIndexes: [0, 1] };
}

function displacement(direction: "BULLISH" | "BEARISH", candles: Candle[], index: number): MomentumMarker {
  return { id: `disp-${direction}-${index}`, type: "DISPLACEMENT", timestamp: candles[index].timestamp, price: candles[index].close, direction, strength: 3, reason: "test displacement", confirmedAtIndex: index, confirmedAtTimestamp: candles[index].timestamp, sourceIndexes: [index], index, bodySize: 1, rangeSize: 1.2, atr: 0.5, closePosition: direction === "BULLISH" ? 0.9 : 0.1 };
}

function structureMarker(direction: "BULLISH" | "BEARISH", candles: Candle[], index: number): StructureMarker {
  return { id: `mss-${direction}-${index}`, type: "MSS", timestamp: candles[index].timestamp, price: candles[index].close, direction, strength: 3, reason: "test structure shift", confirmedAtIndex: index, confirmedAtTimestamp: candles[index].timestamp, sourceIndexes: [index], breakIndex: index, breakPrice: candles[index].close, brokenSwingId: "swing", previousStructure: "RANGING", newStructure: direction, confirmed: true };
}

function baseSetup(type: MarketSetup["type"] = "LIQUIDITY_SWEEP_REVERSAL"): MarketSetup {
  return { id: "setup", type, direction: "BULLISH", state: "WATCH", createdAt: candle(1).timestamp, updatedAt: candle(1).timestamp, createdAtIndex: 1, updatedAtIndex: 1, sourceTimeframe: "1m", relatedHtfContext: "BULLISH", relatedItfContext: "READY", relatedLtfCandles: [1], relatedLiquidity: null, relatedSweep: null, relatedDisplacement: null, relatedStructure: null, relatedFvg: null, setupZone: setupZone(), invalidationLevel: { price: 98, source: "SWEEP_EXTREME", reason: "Close beyond sweep low." }, targetLiquidity: null, score: 80, scoreBreakdown: { htfContext: 15, itfQuality: 15, liquidityQuality: 10, sweepDisplacement: 15, structureQuality: 10, premiumDiscount: 10, sessionQuality: 5, volatilityQuality: 5, candlePsychology: 5 }, reasons: ["watch"], warnings: [], failedReasons: [], antiReversal: { reversalRisk: "LOW", warnings: [], shouldAvoid: false }, history: [] };
}

function setupZone(): SetupZone {
  return { type: "SWEPT_LIQUIDITY_RETEST", minPrice: 99, maxPrice: 100, midpoint: 99.5, createdFrom: "test", strength: 80, reason: "test zone" };
}

function candle(index: number): Candle {
  return candleValues(index, 100, 101, 99, 100.5);
}

function candleValues(index: number, open: number, high: number, low: number, close: number): Candle {
  const timestamp = Date.parse("2026-05-20T00:00:00.000Z") + index * 60_000;
  return { time: new Date(timestamp).toISOString(), timestamp, open, high, low, close, volume: 100, closeTime: timestamp + 60_000, isClosed: true };
}
