import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/candles/types";
import type {
  MarketStructureResult,
  MomentumMarker,
  StructureMarker,
} from "@/lib/market-structure/types";

import {
  calculateHtfBias,
  calculateMarketContext,
  calculatePremiumDiscount,
  calculateSessionContext,
  calculateVolatility,
  classifyRegimeFromMetrics,
  clearMarketContextCache,
  detectSession,
  evaluateItfSetup,
  findNearestLevels,
  scoreKeyLevel,
} from "./engine";
import {
  aggregateCandles,
  clearAggregationCache,
  getContextForCandleTime,
  getTimeframeMapping,
} from "./timeframes";
import type { KeyLevel, RegimeMetrics } from "./types";

describe("market context timeframes", () => {
  it("maps selected chart timeframes to LTF/ITF/HTF context", () => {
    expect(getTimeframeMapping("1m")).toMatchObject({ ltf: "1m", itf: "5m", htf: "15m" });
    expect(getTimeframeMapping("5m")).toMatchObject({ ltf: "5m", itf: "15m", htf: "1h" });
    expect(getTimeframeMapping("15m")).toMatchObject({ ltf: "15m", itf: "1h", htf: "4h" });
    expect(getTimeframeMapping("1h")).toMatchObject({ ltf: "1h", itf: "4h", htf: "1d" });
  });

  it("aggregates complete lower-timeframe candles into OHLCV context candles", () => {
    clearAggregationCache();
    const source = minuteCandles(15);
    const aggregated = aggregateCandles(source, "1m", "5m", "test");

    expect(aggregated).toHaveLength(3);
    expect(aggregated[0]).toMatchObject({
      timestamp: source[0].timestamp,
      open: source[0].open,
      high: Math.max(...source.slice(0, 5).map((item) => item.high)),
      low: Math.min(...source.slice(0, 5).map((item) => item.low)),
      close: source[4].close,
      volume: 500,
      closeTime: source[0].timestamp + 300_000,
      sourceStartIndex: 0,
      sourceEndIndex: 4,
    });
  });

  it("drops incomplete HTF candles instead of leaking partial context", () => {
    const source = minuteCandles(14);

    expect(aggregateCandles(source, "1m", "15m", "incomplete")).toEqual([]);
  });

  it("does not use future ITF/HTF candles for an LTF candle timestamp", () => {
    const source = minuteCandles(30);
    const itf = aggregateCandles(source, "1m", "5m", "nofuture");
    const htf = aggregateCandles(source, "1m", "15m", "nofuture");

    const beforeHtfClose = getContextForCandleTime(source[5].timestamp, source, itf, htf);
    expect(beforeHtfClose.latestClosedItfCandle?.timestamp).toBe(source[0].timestamp);
    expect(beforeHtfClose.latestClosedHtfCandle).toBeNull();
    expect(beforeHtfClose.validContext).toBe(false);

    const afterHtfClose = getContextForCandleTime(source[15].timestamp, source, itf, htf);
    expect(afterHtfClose.latestClosedHtfCandle?.timestamp).toBe(source[0].timestamp);
    expect(afterHtfClose.validContext).toBe(true);
  });
});

describe("HTF bias", () => {
  it("classifies bullish higher-timeframe context from structure and displacement", () => {
    const candles = directionalCandles("up", 20);
    const bias = calculateHtfBias(candles, structure(candles, [
      structureMarker("BOS", "BULLISH", candles, 18),
      displacementMarker("BULLISH", candles, 19),
    ], "BULLISH"));

    expect(bias.bias).toBe("BULLISH");
    expect(bias.strength).toBeGreaterThanOrEqual(50);
    expect(bias.majorSwingHigh).toBeGreaterThan(bias.majorSwingLow ?? 0);
  });

  it("classifies bearish higher-timeframe context from structure and displacement", () => {
    const candles = directionalCandles("down", 20);
    const bias = calculateHtfBias(candles, structure(candles, [
      structureMarker("BOS", "BEARISH", candles, 18),
      displacementMarker("BEARISH", candles, 19),
    ], "BEARISH"));

    expect(bias.bias).toBe("BEARISH");
    expect(bias.strength).toBeGreaterThanOrEqual(50);
  });

  it("stays ranging when completed HTF candles are flat and structure is absent", () => {
    const candles = Array.from({ length: 12 }, (_, index) => candle(index, 100, 101, 99, 100));

    expect(calculateHtfBias(candles, structure(candles)).bias).toBe("RANGING");
  });
});

describe("ITF setup state machine", () => {
  it.each([
    [{ direction: "NONE" }, "NO_SETUP"],
    [{ direction: "BULLISH", liquidityId: "liq" }, "LIQUIDITY_BUILDING"],
    [{ direction: "BULLISH", liquidityId: "liq", sweepProximity: true }, "SWEEP_FORMING"],
    [{ direction: "BULLISH", sweepId: "sweep" }, "SWEEP_CONFIRMED"],
    [{ direction: "BULLISH", sweepId: "sweep", displacementId: "disp" }, "DISPLACEMENT_CONFIRMED"],
    [{ direction: "BULLISH", sweepId: "sweep", displacementId: "disp", structureId: "mss" }, "MSS_CONFIRMED"],
    [{ direction: "BULLISH", pullbackZone: { minPrice: 99, maxPrice: 100 } }, "PULLBACK_FORMING"],
    [{ direction: "BULLISH", sweepId: "sweep", displacementId: "disp", structureId: "mss", pullbackZone: { minPrice: 99, maxPrice: 100 } }, "READY_FOR_LTF_TRIGGER"],
    [{ direction: "BULLISH", invalidated: true, invalidation: 98 }, "INVALIDATED"],
  ] as const)("returns %s for setup evidence", (evidence, expected) => {
    expect(evaluateItfSetup(evidence).setupState).toBe(expected);
  });
});

describe("premium/discount, levels, and regime", () => {
  it("calculates equilibrium and premium/discount zones", () => {
    expect(calculatePremiumDiscount(200, 100, 150)?.zone).toBe("EQUILIBRIUM");
    expect(calculatePremiumDiscount(200, 100, 170)?.zone).toBe("PREMIUM");
    expect(calculatePremiumDiscount(200, 100, 130)?.zone).toBe("DISCOUNT");
    expect(calculatePremiumDiscount(200, 100, 190)?.zone).toBe("DEEP_PREMIUM");
    expect(calculatePremiumDiscount(200, 100, 110)?.zone).toBe("DEEP_DISCOUNT");
    expect(calculatePremiumDiscount(200, 100, 150)?.equilibrium).toBe(150);
  });

  it("finds nearest support, resistance, BSL, and SSL with binary-search ordering", () => {
    const levels = [
      level("ssl", "SSL", 95),
      level("support", "MAJOR_SWING_LOW", 98),
      level("resistance", "MAJOR_SWING_HIGH", 104),
      level("bsl", "BSL", 106),
    ];

    const nearest = findNearestLevels(levels, 100);

    expect(nearest.nearestSupport?.id).toBe("support");
    expect(nearest.nearestResistance?.id).toBe("resistance");
    expect(nearest.nearestBSL?.id).toBe("bsl");
    expect(nearest.nearestSSL?.id).toBe("ssl");
    expect(nearest.distanceToSupport).toBe(2);
    expect(nearest.distanceToResistance).toBe(4);
  });

  it("scores higher-timeframe unswept major levels above weak swept LTF levels", () => {
    const strong = scoreKeyLevel({ timeframe: "HTF", type: "MAJOR_SWING_HIGH", touchedCount: 3, swept: false, ageBars: 5 });
    const weak = scoreKeyLevel({ timeframe: "LTF", type: "FVG", touchedCount: 0, swept: true, ageBars: 200 });

    expect(strong).toBeGreaterThan(weak);
  });

  it.each([
    [metrics({ flow: "BULLISH", overlapRatio: 0.2 }), "TRENDING_BULLISH"],
    [metrics({ flow: "BEARISH", overlapRatio: 0.2 }), "TRENDING_BEARISH"],
    [metrics({ flow: "RANGING", overlapRatio: 0.7, alternatingRatio: 0.3 }), "RANGING"],
    [metrics({ flow: "CHOPPY", overlapRatio: 0.8, alternatingRatio: 0.8 }), "CHOPPY"],
    [metrics({ compression: true }), "COMPRESSION"],
    [metrics({ expansion: true, displacementRatio: 0.2 }), "MOMENTUM_EXPANSION"],
    [metrics({ liquidityGrab: true }), "LIQUIDITY_GRAB"],
    [metrics({ enoughData: false }), "WAIT"],
  ] as const)("classifies %s market regime", (input, expected) => {
    expect(classifyRegimeFromMetrics(input).regime).toBe(expected);
  });
});

describe("sessions and volatility", () => {
  it("detects Asian, London, New York, and London/New York overlap sessions", () => {
    expect(detectSession(Date.parse("2026-05-20T01:00:00.000Z"))).toBe("ASIAN");
    expect(detectSession(Date.parse("2026-05-20T08:00:00.000Z"))).toBe("LONDON");
    expect(detectSession(Date.parse("2026-05-20T20:00:00.000Z"))).toBe("NEW_YORK");
    expect(detectSession(Date.parse("2026-05-20T13:00:00.000Z"))).toBe("LONDON_NEW_YORK_OVERLAP");
  });

  it("calculates current and previous session ranges from completed candles", () => {
    const candles = [
      candleAt("2026-05-20T01:00:00.000Z", 100, 103, 99, 102),
      candleAt("2026-05-20T02:00:00.000Z", 102, 104, 101, 103),
      candleAt("2026-05-20T07:00:00.000Z", 103, 106, 102, 105),
      candleAt("2026-05-20T08:00:00.000Z", 105, 107, 104, 106),
    ];

    const session = calculateSessionContext(candles);

    expect(session.session).toBe("LONDON");
    expect(session.currentSessionHigh).toBe(107);
    expect(session.currentSessionLow).toBe(102);
    expect(session.previousSessionHigh).toBe(104);
    expect(session.previousSessionLow).toBe(99);
  });

  it.each([
    [rangeCandles([...Array(80).fill(10), ...Array(20).fill(1)]), "LOW_VOLATILITY"],
    [rangeCandles(Array(100).fill(10)), "NORMAL_VOLATILITY"],
    [rangeCandles([...Array(80).fill(10), ...Array(20).fill(18)]), "HIGH_VOLATILITY"],
    [rangeCandles([...Array(80).fill(10), ...Array(20).fill(40)]), "EXTREME_VOLATILITY"],
  ] as const)("classifies volatility states", (candles, expected) => {
    expect(calculateVolatility(candles, 14).state).toBe(expected);
  });
});

describe("market context integration", () => {
  it("builds context score, wait reasons, and cached result without emitting trade signals", () => {
    clearMarketContextCache();
    const candles = minuteCandles(120);
    const request = {
      candles,
      symbol: "XAUUSD",
      timeframe: "1m" as const,
      startDate: "2026-05-20T00:00",
      endDate: "2026-05-20T02:00",
      marketStructureSettings: {
        sensitivity: "high" as const,
        leftBars: 1,
        rightBars: 1,
        atrPeriod: 3,
        showOnlyMajor: false,
      },
    };

    const first = calculateMarketContext(request);
    const second = calculateMarketContext(request);

    expect(first.mapping).toMatchObject({ ltf: "1m", itf: "5m", htf: "15m" });
    expect(first.score.overallScore).toBeGreaterThanOrEqual(0);
    expect(first.score.directionPreference).toMatch(/BULLISH|BEARISH|NEUTRAL|WAIT/);
    expect(first.wait.requiredForImprovement).toEqual(expect.any(Array));
    expect(first.cacheStatus).toBe("miss");
    expect(second.cacheStatus).toBe("hit");
  });
});

function candle(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
  stepMs = 60_000,
  start = Date.parse("2026-05-20T00:00:00.000Z"),
): Candle {
  const timestamp = start + index * stepMs;
  return {
    time: new Date(timestamp).toISOString(),
    timestamp,
    open,
    high,
    low,
    close,
    volume: 100,
    closeTime: timestamp + stepMs,
    isClosed: true,
  };
}

function candleAt(
  isoTime: string,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  const timestamp = Date.parse(isoTime);
  return {
    time: new Date(timestamp).toISOString(),
    timestamp,
    open,
    high,
    low,
    close,
    volume: 100,
    closeTime: timestamp + 3_600_000,
    isClosed: true,
  };
}

function minuteCandles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index * 0.1;
    return candle(index, open, open + 0.4, open - 0.3, open + 0.2);
  });
}

function directionalCandles(direction: "up" | "down", count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const base = direction === "up" ? 100 + index : 120 - index;
    return candle(index, base, base + 2, base - 1, direction === "up" ? base + 1 : base - 0.8, 900_000);
  });
}

function rangeCandles(ranges: number[]): Candle[] {
  return ranges.map((range, index) => candle(index, 100, 100 + range / 2, 100 - range / 2, 100));
}

function structure(
  candles: Candle[],
  markers: MarketStructureResult["markers"] = [],
  state: MarketStructureResult["audit"]["currentStructureState"] = "RANGING",
): MarketStructureResult {
  return {
    candles,
    markers,
    markerMap: new Map(markers.map((marker) => [marker.id, marker])),
    liquidityZones: [],
    liquidityZoneMap: new Map(),
    fvgZones: [],
    atr: [],
    audit: {
      totalCandles: candles.length,
      totalSwingHighs: 0,
      totalSwingLows: 0,
      totalBslZones: 0,
      totalSslZones: 0,
      totalEqualHighZones: 0,
      totalEqualLowZones: 0,
      totalSweeps: 0,
      totalSslSweeps: 0,
      totalBslSweeps: 0,
      totalMomentumCandles: 0,
      totalBullishMomentum: 0,
      totalBearishMomentum: 0,
      totalBuyersMarkers: 0,
      totalSellersMarkers: 0,
      totalBos: 0,
      totalChoch: 0,
      totalMss: 0,
      totalFvg: 0,
      totalMitigatedFvg: 0,
      calculationTimeMs: 0,
      lastMarkerCreated: null,
      currentStructureState: state,
      markerSensitivitySettings: {
        sensitivity: "high",
        leftBars: 1,
        rightBars: 1,
        atrPeriod: 3,
        showOnlyMajor: false,
      },
      cacheStatus: "miss",
      validationWarnings: [],
      noRepaintValidationStatus: "pass",
    },
  };
}

function structureMarker(
  type: StructureMarker["type"],
  direction: StructureMarker["direction"],
  candles: Candle[],
  index: number,
): StructureMarker {
  const selected = candles[index];
  return {
    id: `${type}-${direction}-${index}`,
    type,
    timestamp: selected.timestamp,
    price: selected.close,
    direction,
    strength: 3,
    reason: "test structure",
    confirmedAtIndex: index,
    confirmedAtTimestamp: selected.timestamp,
    sourceIndexes: [index],
    breakIndex: index,
    breakPrice: selected.close,
    brokenSwingId: "swing",
    previousStructure: "RANGING",
    newStructure: direction,
    confirmed: true,
  };
}

function displacementMarker(
  direction: MomentumMarker["direction"],
  candles: Candle[],
  index: number,
): MomentumMarker {
  const selected = candles[index];
  return {
    id: `DISPLACEMENT-${direction}-${index}`,
    type: "DISPLACEMENT",
    timestamp: selected.timestamp,
    price: selected.close,
    direction,
    strength: 3,
    reason: "test displacement",
    confirmedAtIndex: index,
    confirmedAtTimestamp: selected.timestamp,
    sourceIndexes: [index],
    index,
    bodySize: Math.abs(selected.close - selected.open),
    rangeSize: selected.high - selected.low,
    atr: selected.high - selected.low,
    closePosition: direction === "BULLISH" ? 0.9 : 0.1,
  };
}

function level(id: string, type: KeyLevel["type"], price: number): KeyLevel {
  return {
    id,
    type,
    timeframe: type === "BSL" || type === "SSL" ? "ITF" : "HTF",
    price,
    minPrice: price,
    maxPrice: price,
    strength: 80,
    touchedCount: 2,
    lastTouchedAt: Date.parse("2026-05-20T00:00:00.000Z"),
    swept: false,
    distanceFromCurrentPrice: Math.abs(price - 100),
    reason: "test level",
  };
}

function metrics(overrides: Partial<RegimeMetrics>): RegimeMetrics {
  return {
    flow: "BULLISH",
    volatility: "NORMAL_VOLATILITY",
    overlapRatio: 0.3,
    alternatingRatio: 0.2,
    displacementRatio: 0.05,
    structureBreaks: 0,
    compression: false,
    expansion: false,
    failedBreakout: false,
    liquidityGrab: false,
    reversalAttempt: false,
    enoughData: true,
    ...overrides,
  };
}
