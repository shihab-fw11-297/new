import type { Candle } from "@/lib/candles/types";

import type {
  BaseMarketMarker,
  FvgZone,
  LiquidityZone,
  MarkerEngineInput,
  MarkerStrength,
  MarketMarker,
  MarketStructureResult,
  MarketStructureSettings,
  MomentumMarker,
  PressureMarker,
  StructureDirection,
  StructureMarker,
  SweepMarker,
  SwingMarker,
} from "./types";

type Thresholds = {
  equalHighAtrTolerance: number;
  bodyAtrMultiplier: number;
  rangeAtrMultiplier: number;
  bodyToRangeRatio: number;
  bullishClosePosition: number;
  bearishClosePosition: number;
  majorStrengthFloor: MarkerStrength;
};

const DEFAULT_SETTINGS: MarketStructureSettings = {
  sensitivity: "normal",
  leftBars: 2,
  rightBars: 2,
  atrPeriod: 14,
  showOnlyMajor: false,
};

const resultCache = new Map<string, MarketStructureResult>();

export function getDefaultMarketStructureSettings(): MarketStructureSettings {
  return { ...DEFAULT_SETTINGS };
}

export function buildMarkerCacheKey(input: MarkerEngineInput): string {
  return [
    input.symbol.trim().toUpperCase(),
    input.timeframe,
    input.startDate,
    input.endDate,
    input.candles.length,
    input.candles[0]?.timestamp ?? "none",
    input.candles.at(-1)?.timestamp ?? "none",
    fingerprintCandles(input.candles),
    input.settings.sensitivity,
    input.settings.leftBars,
    input.settings.rightBars,
    input.settings.atrPeriod,
    input.settings.showOnlyMajor,
  ].join(":");
}

function fingerprintCandles(candles: Candle[]): string {
  let hash = 0;

  for (const candle of candles) {
    const value =
      candle.timestamp +
      Math.round(candle.open * 100) +
      Math.round(candle.high * 100) +
      Math.round(candle.low * 100) +
      Math.round(candle.close * 100);

    hash = (hash * 31 + value) >>> 0;
  }

  return hash.toString(36);
}

export function calculateMarketStructure(
  input: MarkerEngineInput,
): MarketStructureResult {
  const cacheKey = buildMarkerCacheKey(input);
  const cached = resultCache.get(cacheKey);

  if (cached) {
    return {
      ...cached,
      audit: {
        ...cached.audit,
        cacheStatus: "hit",
      },
    };
  }

  const startedAt =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const settings = normalizeSettings(input.settings);
  const thresholds = getThresholds(settings);
  const candles = sanitizeClosedCandles(input.candles);
  const atr = calculateRollingAtr(candles, settings.atrPeriod);
  const markers: MarketMarker[] = [];
  const markerMap = new Map<string, MarketMarker>();
  const validationWarnings: string[] = [];

  const swings = detectSwings(candles, atr, settings);
  for (const swing of swings) {
    pushMarker(markers, markerMap, swing);
  }

  const {
    liquidityZones,
    liquidityZoneMap,
    sweeps,
  } = detectLiquidityAndSweeps({
    swings,
    candles,
    atr,
    thresholds,
  });

  const momentumMarkers = detectMomentum(candles, atr, thresholds);
  const momentumByIndex = new Map<number, MomentumMarker>();

  for (const momentum of momentumMarkers) {
    momentumByIndex.set(momentum.index, momentum);
    pushMarker(markers, markerMap, momentum);
  }

  for (const sweep of sweeps) {
    pushMarker(markers, markerMap, sweep);
  }

  for (const pressure of detectPressure(candles, momentumMarkers, sweeps)) {
    pushMarker(markers, markerMap, pressure);
  }

  const structureMarkers = detectStructure(candles, swings, sweeps, momentumByIndex);
  for (const structure of structureMarkers) {
    pushMarker(markers, markerMap, structure);
  }

  const fvgZones = detectFvg(candles, momentumByIndex);
  for (const fvg of fvgZones) {
    pushMarker(markers, markerMap, fvg);
  }

  const filteredMarkers = settings.showOnlyMajor
    ? markers.filter((marker) => marker.strength >= thresholds.majorStrengthFloor)
    : markers;
  const filteredMarkerMap = new Map(
    filteredMarkers.map((marker) => [marker.id, marker]),
  );

  validateMarkerTiming(filteredMarkers, candles, validationWarnings);
  filteredMarkers.sort((a, b) => {
    if (a.confirmedAtIndex !== b.confirmedAtIndex) {
      return a.confirmedAtIndex - b.confirmedAtIndex;
    }

    return a.timestamp - b.timestamp;
  });

  const endedAt =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const currentStructureState = readCurrentStructureState(structureMarkers);
  const result: MarketStructureResult = {
    candles,
    markers: filteredMarkers,
    markerMap: filteredMarkerMap,
    liquidityZones,
    liquidityZoneMap,
    fvgZones,
    atr,
    audit: {
      totalCandles: candles.length,
      totalSwingHighs: swings.filter((marker) => marker.type === "SWING_HIGH")
        .length,
      totalSwingLows: swings.filter((marker) => marker.type === "SWING_LOW")
        .length,
      totalBslZones: liquidityZones.filter((zone) => zone.type === "BSL").length,
      totalSslZones: liquidityZones.filter((zone) => zone.type === "SSL").length,
      totalEqualHighZones: liquidityZones.filter(
        (zone) => zone.type === "BSL" && zone.touches > 1,
      ).length,
      totalEqualLowZones: liquidityZones.filter(
        (zone) => zone.type === "SSL" && zone.touches > 1,
      ).length,
      totalSweeps: sweeps.length,
      totalSslSweeps: sweeps.filter((marker) => marker.type === "SSL_SWEEP")
        .length,
      totalBslSweeps: sweeps.filter((marker) => marker.type === "BSL_SWEEP")
        .length,
      totalMomentumCandles: momentumMarkers.length,
      totalBullishMomentum: momentumMarkers.filter(
        (marker) => marker.direction === "BULLISH",
      ).length,
      totalBearishMomentum: momentumMarkers.filter(
        (marker) => marker.direction === "BEARISH",
      ).length,
      totalBuyersMarkers: filteredMarkers.filter((marker) => marker.type === "BUYERS")
        .length,
      totalSellersMarkers: filteredMarkers.filter(
        (marker) => marker.type === "SELLERS",
      ).length,
      totalBos: structureMarkers.filter((marker) => marker.type === "BOS").length,
      totalChoch: structureMarkers.filter((marker) => marker.type === "CHOCH")
        .length,
      totalMss: structureMarkers.filter((marker) => marker.type === "MSS").length,
      totalFvg: fvgZones.length,
      totalMitigatedFvg: fvgZones.filter((zone) => zone.mitigated).length,
      calculationTimeMs: Math.round(endedAt - startedAt),
      lastMarkerCreated: filteredMarkers.at(-1)?.id ?? null,
      currentStructureState,
      markerSensitivitySettings: settings,
      cacheStatus: "miss",
      validationWarnings,
      noRepaintValidationStatus:
        validationWarnings.length === 0 ? "pass" : "warning",
    },
  };

  resultCache.set(cacheKey, result);
  return result;
}

export function getReplayVisibleMarkers(
  markers: MarketMarker[],
  replayIndex: number,
): MarketMarker[] {
  return markers
    .filter((marker) => marker.confirmedAtIndex <= replayIndex)
    .map((marker) => cloneMarkerForReplay(marker, replayIndex));
}

export function getReplayVisibleZones(
  zones: LiquidityZone[],
  replayIndex: number,
): LiquidityZone[] {
  return zones
    .filter((zone) => zone.confirmedAtIndex <= replayIndex)
    .map((zone) => {
      if (
        zone.swept &&
        typeof zone.sweptAtIndex === "number" &&
        zone.sweptAtIndex > replayIndex
      ) {
        return {
          ...zone,
          swept: false,
          sweptAt: undefined,
          sweptAtIndex: undefined,
        };
      }

      return zone;
    });
}

export function clearMarketStructureCache(): void {
  resultCache.clear();
}

export function validateMarkerTiming(
  markers: MarketMarker[],
  candles: Candle[],
  warnings: string[] = [],
): string[] {
  for (const marker of markers) {
    if (!Number.isInteger(marker.confirmedAtIndex)) {
      warnings.push(`${marker.id} is missing confirmedAtIndex.`);
      continue;
    }

    if (marker.confirmedAtIndex < 0 || marker.confirmedAtIndex >= candles.length) {
      warnings.push(`${marker.id} confirmedAtIndex is outside candle range.`);
    }

    const maxSourceIndex = Math.max(...marker.sourceIndexes);

    if (marker.confirmedAtIndex < maxSourceIndex) {
      warnings.push(
        `${marker.id} confirmed before all source candles closed. This marker would repaint.`,
      );
    }
  }

  return warnings;
}

function detectSwings(
  candles: Candle[],
  atr: number[],
  settings: MarketStructureSettings,
): SwingMarker[] {
  const swings: SwingMarker[] = [];

  for (
    let index = settings.leftBars;
    index < candles.length - settings.rightBars;
    index += 1
  ) {
    const candle = candles[index];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let cursor = index - settings.leftBars; cursor <= index + settings.rightBars; cursor += 1) {
      if (cursor === index) {
        continue;
      }

      if (candles[cursor].high >= candle.high) {
        isSwingHigh = false;
      }

      if (candles[cursor].low <= candle.low) {
        isSwingLow = false;
      }
    }

    const confirmedAtIndex = index + settings.rightBars;
    const sourceIndexes = createSourceIndexes(
      index - settings.leftBars,
      index + settings.rightBars,
    );

    if (isSwingHigh) {
      const strength = scoreSwingStrength(candles, atr, index, "high");
      swings.push({
        ...baseMarker({
          type: "SWING_HIGH",
          candles,
          index,
          price: candle.high,
          direction: "BEARISH",
          strength,
          reason: `Confirmed swing high: high exceeded ${settings.leftBars} left and ${settings.rightBars} right candles.`,
          confirmedAtIndex,
          sourceIndexes,
        }),
        type: "SWING_HIGH",
        candleIndex: index,
      });
    }

    if (isSwingLow) {
      const strength = scoreSwingStrength(candles, atr, index, "low");
      swings.push({
        ...baseMarker({
          type: "SWING_LOW",
          candles,
          index,
          price: candle.low,
          direction: "BULLISH",
          strength,
          reason: `Confirmed swing low: low undercut ${settings.leftBars} left and ${settings.rightBars} right candles.`,
          confirmedAtIndex,
          sourceIndexes,
        }),
        type: "SWING_LOW",
        candleIndex: index,
      });
    }
  }

  return swings.sort((a, b) => a.confirmedAtIndex - b.confirmedAtIndex);
}

function createOrMergeLiquidityZone({
  swing,
  candles,
  atr,
  thresholds,
  liquidityZones,
  liquidityZoneMap,
  zoneIndexes,
}: {
  swing: SwingMarker;
  candles: Candle[];
  atr: number[];
  thresholds: Thresholds;
  liquidityZones: LiquidityZone[];
  liquidityZoneMap: Map<string, LiquidityZone>;
  zoneIndexes: { BSL: string[]; SSL: string[] };
}) {
  const zoneType = swing.type === "SWING_HIGH" ? "BSL" : "SSL";
  const tolerance = Math.max(
    atr[swing.candleIndex] * thresholds.equalHighAtrTolerance,
    candles[swing.candleIndex].close * 0.00005,
  );
  const matchingZone = findLiquidityZoneWithinTolerance({
    zoneType,
    price: swing.price,
    tolerance,
    liquidityZoneMap,
    zoneIndexes,
  });

  if (matchingZone) {
    matchingZone.price =
      (matchingZone.price * matchingZone.touches + swing.price) /
      (matchingZone.touches + 1);
    matchingZone.minPrice = Math.min(matchingZone.minPrice, swing.price - tolerance);
    matchingZone.maxPrice = Math.max(matchingZone.maxPrice, swing.price + tolerance);
    matchingZone.endIndex = swing.candleIndex;
    matchingZone.touches += 1;
    matchingZone.strength = maxStrength(matchingZone.strength, swing.strength);
    matchingZone.confirmedAtIndex = Math.max(
      matchingZone.confirmedAtIndex,
      swing.confirmedAtIndex,
    );
    matchingZone.confirmedAtTimestamp =
      candles[matchingZone.confirmedAtIndex]?.timestamp ??
      matchingZone.confirmedAtTimestamp;
    matchingZone.sourceIndexes = uniqueSortedIndexes([
      ...matchingZone.sourceIndexes,
      ...swing.sourceIndexes,
    ]);
    matchingZone.reason = `${zoneType} merged from ${matchingZone.touches} equal ${zoneType === "BSL" ? "highs" : "lows"} within ATR tolerance.`;
    resortZoneIdSorted(zoneIndexes[zoneType], matchingZone.id, liquidityZoneMap);
    return;
  }

  const zone: LiquidityZone = {
    id: stableId(zoneType, candles[swing.candleIndex].timestamp, swing.price),
    type: zoneType,
    price: swing.price,
    minPrice: swing.price - tolerance,
    maxPrice: swing.price + tolerance,
    startIndex: swing.candleIndex,
    endIndex: swing.candleIndex,
    timestamp: candles[swing.candleIndex].timestamp,
    strength: swing.strength,
    touches: 1,
    swept: false,
    reason: `${zoneType} created from confirmed ${swing.type === "SWING_HIGH" ? "swing high" : "swing low"}.`,
    confirmedAtIndex: swing.confirmedAtIndex,
    confirmedAtTimestamp: swing.confirmedAtTimestamp,
    sourceIndexes: [...swing.sourceIndexes],
  };

  liquidityZones.push(zone);
  liquidityZoneMap.set(zone.id, zone);
  insertZoneIdSorted(zoneIndexes[zoneType], zone.id, liquidityZoneMap);
}

function detectLiquidityAndSweeps({
  swings,
  candles,
  atr,
  thresholds,
}: {
  swings: SwingMarker[];
  candles: Candle[];
  atr: number[];
  thresholds: Thresholds;
}): {
  liquidityZones: LiquidityZone[];
  liquidityZoneMap: Map<string, LiquidityZone>;
  sweeps: SweepMarker[];
} {
  const liquidityZones: LiquidityZone[] = [];
  const liquidityZoneMap = new Map<string, LiquidityZone>();
  const zoneIndexes = {
    BSL: [] as string[],
    SSL: [] as string[],
  };
  const sweeps: SweepMarker[] = [];
  const sortedSwings = [...swings].sort(
    (a, b) => a.confirmedAtIndex - b.confirmedAtIndex,
  );
  let swingCursor = 0;

  for (let index = 0; index < candles.length; index += 1) {
    while (
      swingCursor < sortedSwings.length &&
      sortedSwings[swingCursor].confirmedAtIndex <= index
    ) {
      createOrMergeLiquidityZone({
        swing: sortedSwings[swingCursor],
        candles,
        atr,
        thresholds,
        liquidityZones,
        liquidityZoneMap,
        zoneIndexes,
      });
      swingCursor += 1;
    }

    for (const zone of liquidityZones) {
      const sweep = detectSweepForZone(candles, atr, zone, index);

      if (sweep) {
        sweeps.push(sweep);
      }
    }
  }

  return { liquidityZones, liquidityZoneMap, sweeps };
}

function detectSweepForZone(
  candles: Candle[],
  atr: number[],
  zone: LiquidityZone,
  index: number,
): SweepMarker | null {
  if (zone.swept || zone.confirmedAtIndex >= index) {
    return null;
  }

  const candle = candles[index];

  if (zone.type === "SSL" && candle.low < zone.minPrice) {
        const sweepDistance = zone.minPrice - candle.low;
        const rejectionStrength = scoreBullishRejection(candle);
        const sweepKind = classifySweep({
          sweepDistance,
          atr: atr[index],
          wickRejected: candle.close >= zone.minPrice,
        });
        const acceptedCloseThrough =
          sweepKind === "CLOSE_THROUGH" &&
          rejectionStrength >= 0.15 &&
          candle.close >= zone.minPrice - Math.max(atr[index] * 0.35, 0);
        const acceptedDeepSweep =
          sweepKind === "DEEP_SWEEP" && rejectionStrength >= 0.15;

        if (
          candle.close >= zone.minPrice ||
          acceptedDeepSweep ||
          acceptedCloseThrough
        ) {
          zone.swept = true;
          zone.sweptAt = candle.timestamp;
          zone.sweptAtIndex = index;
          return {
            ...baseMarker({
              type: "SSL_SWEEP",
              candles,
              index,
              price: candle.low,
              direction: "BULLISH",
              strength: scoreSweepStrength(rejectionStrength, sweepDistance, atr[index]),
              reason: `SSL Sweep detected because candle low swept previous sell-side liquidity and ${describeSweepKind(sweepKind)}. This is only a liquidity event, not a BUY entry.`,
              confirmedAtIndex: index,
              sourceIndexes: [...zone.sourceIndexes, index],
            }),
            type: "SSL_SWEEP",
            direction: "BULLISH",
            sweptLiquidityId: zone.id,
            sweepIndex: index,
            sweepPrice: candle.low,
            closePrice: candle.close,
            rejectionStrength,
            atrDistance: atr[index] > 0 ? sweepDistance / atr[index] : 0,
            sweepKind,
          };
        }
      }

  if (zone.type === "BSL" && candle.high > zone.maxPrice) {
        const sweepDistance = candle.high - zone.maxPrice;
        const rejectionStrength = scoreBearishRejection(candle);
        const sweepKind = classifySweep({
          sweepDistance,
          atr: atr[index],
          wickRejected: candle.close <= zone.maxPrice,
        });
        const acceptedCloseThrough =
          sweepKind === "CLOSE_THROUGH" &&
          rejectionStrength >= 0.15 &&
          candle.close <= zone.maxPrice + Math.max(atr[index] * 0.35, 0);
        const acceptedDeepSweep =
          sweepKind === "DEEP_SWEEP" && rejectionStrength >= 0.15;

        if (
          candle.close <= zone.maxPrice ||
          acceptedDeepSweep ||
          acceptedCloseThrough
        ) {
          zone.swept = true;
          zone.sweptAt = candle.timestamp;
          zone.sweptAtIndex = index;
          return {
            ...baseMarker({
              type: "BSL_SWEEP",
              candles,
              index,
              price: candle.high,
              direction: "BEARISH",
              strength: scoreSweepStrength(rejectionStrength, sweepDistance, atr[index]),
              reason: `BSL Sweep detected because candle high swept previous buy-side liquidity and ${describeSweepKind(sweepKind)}. This is only a liquidity event, not a SELL entry.`,
              confirmedAtIndex: index,
              sourceIndexes: [...zone.sourceIndexes, index],
            }),
            type: "BSL_SWEEP",
            direction: "BEARISH",
            sweptLiquidityId: zone.id,
            sweepIndex: index,
            sweepPrice: candle.high,
            closePrice: candle.close,
            rejectionStrength,
            atrDistance: atr[index] > 0 ? sweepDistance / atr[index] : 0,
            sweepKind,
          };
        }
      }

  return null;
}

function detectMomentum(
  candles: Candle[],
  atr: number[],
  thresholds: Thresholds,
): MomentumMarker[] {
  const markers: MomentumMarker[] = [];

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const rangeSize = candle.high - candle.low;
    const bodySize = Math.abs(candle.close - candle.open);

    if (rangeSize <= 0 || atr[index] <= 0) {
      continue;
    }

    const bodyRatio = bodySize / rangeSize;
    const closePosition = (candle.close - candle.low) / rangeSize;
    const bullish =
      candle.close > candle.open &&
      bodySize >= atr[index] * thresholds.bodyAtrMultiplier &&
      rangeSize >= atr[index] * thresholds.rangeAtrMultiplier &&
      bodyRatio >= thresholds.bodyToRangeRatio &&
      closePosition >= thresholds.bullishClosePosition;
    const bearish =
      candle.close < candle.open &&
      bodySize >= atr[index] * thresholds.bodyAtrMultiplier &&
      rangeSize >= atr[index] * thresholds.rangeAtrMultiplier &&
      bodyRatio >= thresholds.bodyToRangeRatio &&
      closePosition <= thresholds.bearishClosePosition;

    if (!bullish && !bearish) {
      continue;
    }

    const strength = scoreMomentumStrength(bodySize, rangeSize, atr[index], bodyRatio);
    const direction = bullish ? "BULLISH" : "BEARISH";
    const type = strength >= 2 ? "DISPLACEMENT" : "MOMENTUM";

    markers.push({
      ...baseMarker({
        type,
        candles,
        index,
        price: bullish ? candle.high : candle.low,
        direction,
        strength,
        reason: `${direction.toLowerCase()} ${type.toLowerCase()} candle: body and range expanded versus ATR and closed near the ${bullish ? "high" : "low"}.`,
        confirmedAtIndex: index,
        sourceIndexes: [index],
      }),
      type,
      direction,
      index,
      bodySize,
      rangeSize,
      atr: atr[index],
      closePosition,
    });
  }

  return markers;
}

function detectPressure(
  candles: Candle[],
  momentumMarkers: MomentumMarker[],
  sweeps: SweepMarker[],
): PressureMarker[] {
  const markers: PressureMarker[] = [];

  for (const momentum of momentumMarkers) {
    if (momentum.type !== "DISPLACEMENT") {
      continue;
    }

    const relatedSweep = findRecentSweep(sweeps, momentum.index, momentum.direction);
    const type = momentum.direction === "BULLISH" ? "BUYERS" : "SELLERS";

    markers.push({
      ...baseMarker({
        type,
        candles,
        index: momentum.index,
        price: momentum.price,
        direction: momentum.direction,
        strength: relatedSweep ? maxStrength(momentum.strength, 2) : momentum.strength,
        reason:
          type === "BUYERS"
            ? "BUYERS pressure marker from bullish displacement. This is visual pressure only, not a BUY signal."
            : "SELLERS pressure marker from bearish displacement. This is visual pressure only, not a SELL signal.",
        confirmedAtIndex: momentum.confirmedAtIndex,
        sourceIndexes: relatedSweep
          ? [...momentum.sourceIndexes, ...relatedSweep.sourceIndexes]
          : momentum.sourceIndexes,
      }),
      type,
      direction: momentum.direction,
      index: momentum.index,
      relatedSweepId: relatedSweep?.id,
      relatedMomentumId: momentum.id,
    });
  }

  return markers;
}

function detectStructure(
  candles: Candle[],
  swings: SwingMarker[],
  sweeps: SweepMarker[],
  momentumByIndex: Map<number, MomentumMarker>,
): StructureMarker[] {
  const markers: StructureMarker[] = [];
  let structure: StructureDirection = "UNKNOWN";
  let lastHigh: SwingMarker | undefined;
  let lastLow: SwingMarker | undefined;
  let swingCursor = 0;
  const brokenSwingIds = new Set<string>();

  for (let index = 0; index < candles.length; index += 1) {
    while (
      swingCursor < swings.length &&
      swings[swingCursor].confirmedAtIndex <= index
    ) {
      const swing = swings[swingCursor];

      if (swing.type === "SWING_HIGH") {
        lastHigh = swing;
      } else {
        lastLow = swing;
      }

      swingCursor += 1;
    }

    const candle = candles[index];

    if (lastHigh && candle.close > lastHigh.price && !brokenSwingIds.has(lastHigh.id)) {
      const previousStructure = structure;
      const type: "BOS" | "CHOCH" =
        structure === "BEARISH" ? "CHOCH" : "BOS";
      structure = "BULLISH";
      brokenSwingIds.add(lastHigh.id);
      markers.push(createStructureMarker({
        type,
        candles,
        index,
        direction: "BULLISH",
        price: candle.close,
        brokenSwing: lastHigh,
        previousStructure,
        newStructure: structure,
      }));
    }

    if (lastLow && candle.close < lastLow.price && !brokenSwingIds.has(lastLow.id)) {
      const previousStructure = structure;
      const type: "BOS" | "CHOCH" =
        structure === "BULLISH" ? "CHOCH" : "BOS";
      structure = "BEARISH";
      brokenSwingIds.add(lastLow.id);
      markers.push(createStructureMarker({
        type,
        candles,
        index,
        direction: "BEARISH",
        price: candle.close,
        brokenSwing: lastLow,
        previousStructure,
        newStructure: structure,
      }));
    }

    const recentSweep = sweeps.findLast(
      (sweep) =>
        sweep.confirmedAtIndex <= index &&
        index - sweep.sweepIndex <= 5 &&
        sweep.direction === momentumByIndex.get(index)?.direction,
    );
    const momentum = momentumByIndex.get(index);

    if (!recentSweep || !momentum || momentum.type !== "DISPLACEMENT") {
      continue;
    }

    if (
      momentum.direction === "BULLISH" &&
      lastHigh &&
      candle.close > lastHigh.price
    ) {
      markers.push(createStructureMarker({
        type: "MSS",
        candles,
        index,
        direction: "BULLISH",
        price: candle.close,
        brokenSwing: lastHigh,
        previousStructure: structure,
        newStructure: "BULLISH",
        extraReason:
          "MSS requires liquidity sweep, opposite displacement, and close beyond minor structure.",
      }));
      structure = "BULLISH";
    }

    if (
      momentum.direction === "BEARISH" &&
      lastLow &&
      candle.close < lastLow.price
    ) {
      markers.push(createStructureMarker({
        type: "MSS",
        candles,
        index,
        direction: "BEARISH",
        price: candle.close,
        brokenSwing: lastLow,
        previousStructure: structure,
        newStructure: "BEARISH",
        extraReason:
          "MSS requires liquidity sweep, opposite displacement, and close beyond minor structure.",
      }));
      structure = "BEARISH";
    }
  }

  return markers;
}

function detectFvg(
  candles: Candle[],
  momentumByIndex: Map<number, MomentumMarker>,
): FvgZone[] {
  const zones: FvgZone[] = [];

  for (let index = 1; index < candles.length - 1; index += 1) {
    const previous = candles[index - 1];
    const next = candles[index + 1];
    const momentum = momentumByIndex.get(index);

    if (!momentum || momentum.type !== "DISPLACEMENT") {
      continue;
    }

    if (previous.high < next.low && momentum.direction === "BULLISH") {
      zones.push(createFvg({
        candles,
        index,
        direction: "BULLISH",
        minPrice: previous.high,
        maxPrice: next.low,
      }));
    }

    if (previous.low > next.high && momentum.direction === "BEARISH") {
      zones.push(createFvg({
        candles,
        index,
        direction: "BEARISH",
        minPrice: next.high,
        maxPrice: previous.low,
      }));
    }
  }

  return markFvgMitigation(candles, zones);
}

export function calculateRollingAtr(candles: Candle[], period: number): number[] {
  const atr: number[] = [];
  let rollingSum = 0;
  const trueRanges: number[] = [];

  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1]?.close ?? candle.close;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );

    trueRanges.push(trueRange);
    rollingSum += trueRange;

    if (trueRanges.length > period) {
      rollingSum -= trueRanges[index - period];
    }

    atr.push(rollingSum / Math.min(index + 1, period));
  }

  return atr;
}

function pushMarker(
  markers: MarketMarker[],
  markerMap: Map<string, MarketMarker>,
  marker: MarketMarker,
): void {
  if (markerMap.has(marker.id)) {
    return;
  }

  markers.push(marker);
  markerMap.set(marker.id, marker);
}

function baseMarker({
  type,
  candles,
  index,
  price,
  direction,
  strength,
  reason,
  confirmedAtIndex,
  sourceIndexes,
}: {
  type: BaseMarketMarker["type"];
  candles: Candle[];
  index: number;
  price: number;
  direction: BaseMarketMarker["direction"];
  strength: MarkerStrength;
  reason: string;
  confirmedAtIndex: number;
  sourceIndexes: number[];
}): BaseMarketMarker {
  return {
    id: stableId(type, candles[index].timestamp, price),
    type,
    timestamp: candles[index].timestamp,
    price,
    direction,
    strength,
    reason,
    confirmedAtIndex,
    confirmedAtTimestamp: candles[confirmedAtIndex]?.timestamp ?? candles[index].timestamp,
    sourceIndexes,
  };
}

function createStructureMarker({
  type,
  candles,
  index,
  direction,
  price,
  brokenSwing,
  previousStructure,
  newStructure,
  extraReason,
}: {
  type: "BOS" | "CHOCH" | "MSS";
  candles: Candle[];
  index: number;
  direction: "BULLISH" | "BEARISH";
  price: number;
  brokenSwing: SwingMarker;
  previousStructure: StructureDirection;
  newStructure: StructureDirection;
  extraReason?: string;
}): StructureMarker {
  return {
    ...baseMarker({
      type,
      candles,
      index,
      price,
      direction,
      strength: type === "MSS" ? 3 : type === "CHOCH" ? 2 : 1,
      reason:
        extraReason ??
        `${type} ${direction.toLowerCase()} confirmed by candle close beyond a confirmed swing level, not only a wick break.`,
      confirmedAtIndex: index,
      sourceIndexes: [...brokenSwing.sourceIndexes, index],
    }),
    type,
    direction,
    breakIndex: index,
    breakPrice: price,
    brokenSwingId: brokenSwing.id,
    previousStructure,
    newStructure,
    confirmed: true,
  };
}

function createFvg({
  candles,
  index,
  direction,
  minPrice,
  maxPrice,
}: {
  candles: Candle[];
  index: number;
  direction: "BULLISH" | "BEARISH";
  minPrice: number;
  maxPrice: number;
}): FvgZone {
  const confirmedAtIndex = index + 1;

  return {
    ...baseMarker({
      type: "FVG",
      candles,
      index,
      price: direction === "BULLISH" ? minPrice : maxPrice,
      direction,
      strength: 2,
      reason: `${direction} fair value gap confirmed after the next candle closed around a displacement candle.`,
      confirmedAtIndex,
      sourceIndexes: [index - 1, index, index + 1],
    }),
    type: "FVG",
    direction,
    startIndex: index - 1,
    middleIndex: index,
    endIndex: index + 1,
    minPrice,
    maxPrice,
    createdAt: candles[confirmedAtIndex].timestamp,
    mitigated: false,
  };
}

function markFvgMitigation(candles: Candle[], zones: FvgZone[]): FvgZone[] {
  for (const zone of zones) {
    for (let index = zone.endIndex + 1; index < candles.length; index += 1) {
      const candle = candles[index];
      const touchedZone = candle.low <= zone.maxPrice && candle.high >= zone.minPrice;

      if (touchedZone) {
        zone.mitigated = true;
        zone.mitigatedAt = candle.timestamp;
        zone.mitigatedAtIndex = index;
        break;
      }
    }
  }

  return zones;
}

function findLiquidityZoneWithinTolerance({
  zoneType,
  price,
  tolerance,
  liquidityZoneMap,
  zoneIndexes,
}: {
  zoneType: "BSL" | "SSL";
  price: number;
  tolerance: number;
  liquidityZoneMap: Map<string, LiquidityZone>;
  zoneIndexes: { BSL: string[]; SSL: string[] };
}): LiquidityZone | undefined {
  const ids = zoneIndexes[zoneType];
  const start = lowerBoundZonePrice(ids, price - tolerance, liquidityZoneMap);

  for (let index = start; index < ids.length; index += 1) {
    const zone = liquidityZoneMap.get(ids[index]);

    if (!zone) {
      continue;
    }

    if (zone.price > price + tolerance) {
      break;
    }

    if (!zone.swept && Math.abs(zone.price - price) <= tolerance) {
      return zone;
    }
  }

  return undefined;
}

function lowerBoundZonePrice(
  ids: string[],
  price: number,
  liquidityZoneMap: Map<string, LiquidityZone>,
): number {
  let left = 0;
  let right = ids.length;

  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    const zone = liquidityZoneMap.get(ids[middle]);
    const zonePrice = zone?.price ?? Number.POSITIVE_INFINITY;

    if (zonePrice < price) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return left;
}

function insertZoneIdSorted(
  ids: string[],
  id: string,
  liquidityZoneMap: Map<string, LiquidityZone>,
): void {
  const zone = liquidityZoneMap.get(id);

  if (!zone) {
    return;
  }

  const index = lowerBoundZonePrice(ids, zone.price, liquidityZoneMap);
  ids.splice(index, 0, id);
}

function resortZoneIdSorted(
  ids: string[],
  id: string,
  liquidityZoneMap: Map<string, LiquidityZone>,
): void {
  const existingIndex = ids.indexOf(id);

  if (existingIndex >= 0) {
    ids.splice(existingIndex, 1);
  }

  insertZoneIdSorted(ids, id, liquidityZoneMap);
}

function uniqueSortedIndexes(indexes: number[]): number[] {
  return [...new Set(indexes)].sort((a, b) => a - b);
}

function scoreSwingStrength(
  candles: Candle[],
  atr: number[],
  index: number,
  side: "high" | "low",
): MarkerStrength {
  const candle = candles[index];
  const left = candles[index - 1];
  const right = candles[index + 1];
  const localDistance =
    side === "high"
      ? candle.high - Math.max(left?.high ?? candle.high, right?.high ?? candle.high)
      : Math.min(left?.low ?? candle.low, right?.low ?? candle.low) - candle.low;
  const atrDistance = atr[index] > 0 ? localDistance / atr[index] : 0;

  if (atrDistance >= 0.7) {
    return 3;
  }

  if (atrDistance >= 0.35) {
    return 2;
  }

  return 1;
}

function scoreBullishRejection(candle: Candle): number {
  const range = candle.high - candle.low;
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  const closePosition = range > 0 ? (candle.close - candle.low) / range : 0;
  return range > 0 ? lowerWick / range + closePosition : 0;
}

function scoreBearishRejection(candle: Candle): number {
  const range = candle.high - candle.low;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const closePosition = range > 0 ? (candle.high - candle.close) / range : 0;
  return range > 0 ? upperWick / range + closePosition : 0;
}

function scoreSweepStrength(
  rejectionStrength: number,
  sweepDistance: number,
  atr: number,
): MarkerStrength {
  const atrDistance = atr > 0 ? sweepDistance / atr : 0;

  if (rejectionStrength >= 1.1 || atrDistance >= 0.75) {
    return 3;
  }

  if (rejectionStrength >= 0.7 || atrDistance >= 0.35) {
    return 2;
  }

  return 1;
}

function classifySweep({
  sweepDistance,
  atr,
  wickRejected,
}: {
  sweepDistance: number;
  atr: number;
  wickRejected: boolean;
}): SweepMarker["sweepKind"] {
  if (atr > 0 && sweepDistance > atr * 0.7) {
    return "DEEP_SWEEP";
  }

  return wickRejected ? "WICK_SWEEP" : "CLOSE_THROUGH";
}

function describeSweepKind(kind: SweepMarker["sweepKind"]): string {
  if (kind === "WICK_SWEEP") {
    return "closed back inside the liquidity zone";
  }

  if (kind === "DEEP_SWEEP") {
    return "made a deep ATR-sized sweep";
  }

  return "closed through the zone with only weak rejection";
}

function cloneMarkerForReplay(
  marker: MarketMarker,
  replayIndex: number,
): MarketMarker {
  if (
    marker.type === "FVG" &&
    marker.mitigated &&
    typeof marker.mitigatedAtIndex === "number" &&
    marker.mitigatedAtIndex > replayIndex
  ) {
    return {
      ...marker,
      mitigated: false,
      mitigatedAt: undefined,
      mitigatedAtIndex: undefined,
    };
  }

  return marker;
}

function scoreMomentumStrength(
  bodySize: number,
  rangeSize: number,
  atr: number,
  bodyRatio: number,
): MarkerStrength {
  if (bodySize >= atr * 1.1 && rangeSize >= atr * 1.4 && bodyRatio >= 0.7) {
    return 3;
  }

  if (bodySize >= atr * 0.8 && rangeSize >= atr * 1.1) {
    return 2;
  }

  return 1;
}

function findRecentSweep(
  sweeps: SweepMarker[],
  index: number,
  direction: "BULLISH" | "BEARISH",
): SweepMarker | undefined {
  return sweeps.findLast(
    (sweep) =>
      sweep.direction === direction &&
      sweep.confirmedAtIndex <= index &&
      index - sweep.sweepIndex <= 5,
  );
}

function getThresholds(settings: MarketStructureSettings): Thresholds {
  if (settings.sensitivity === "high") {
    return {
      equalHighAtrTolerance: 0.16,
      bodyAtrMultiplier: 0.45,
      rangeAtrMultiplier: 0.7,
      bodyToRangeRatio: 0.5,
      bullishClosePosition: 0.6,
      bearishClosePosition: 0.4,
      majorStrengthFloor: 2,
    };
  }

  if (settings.sensitivity === "low") {
    return {
      equalHighAtrTolerance: 0.08,
      bodyAtrMultiplier: 0.8,
      rangeAtrMultiplier: 1.1,
      bodyToRangeRatio: 0.62,
      bullishClosePosition: 0.72,
      bearishClosePosition: 0.28,
      majorStrengthFloor: 3,
    };
  }

  return {
    equalHighAtrTolerance: 0.1,
    bodyAtrMultiplier: 0.6,
    rangeAtrMultiplier: 0.9,
    bodyToRangeRatio: 0.55,
    bullishClosePosition: 0.65,
    bearishClosePosition: 0.35,
    majorStrengthFloor: 2,
  };
}

function normalizeSettings(
  settings: MarketStructureSettings,
): MarketStructureSettings {
  return {
    sensitivity: settings.sensitivity,
    leftBars: clampInteger(settings.leftBars, 1, 10),
    rightBars: clampInteger(settings.rightBars, 1, 10),
    atrPeriod: clampInteger(settings.atrPeriod, 2, 100),
    showOnlyMajor: settings.showOnlyMajor,
  };
}

function readCurrentStructureState(
  markers: StructureMarker[],
): StructureDirection {
  return markers.at(-1)?.newStructure ?? "UNKNOWN";
}

function createSourceIndexes(start: number, end: number): number[] {
  const indexes: number[] = [];

  for (let index = start; index <= end; index += 1) {
    indexes.push(index);
  }

  return indexes;
}

function sanitizeClosedCandles(candles: Candle[]): Candle[] {
  const byTimestamp = new Map<number, Candle>();

  for (const candle of candles) {
    if (
      !candle.isClosed ||
      !Number.isFinite(candle.timestamp) ||
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close) ||
      candle.high < Math.max(candle.open, candle.close) ||
      candle.low > Math.min(candle.open, candle.close) ||
      candle.low > candle.high
    ) {
      continue;
    }

    byTimestamp.set(candle.timestamp, candle);
  }

  return Array.from(byTimestamp.values()).sort(
    (a, b) => a.timestamp - b.timestamp,
  );
}

function maxStrength(a: MarkerStrength, b: MarkerStrength): MarkerStrength {
  return Math.max(a, b) as MarkerStrength;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function stableId(type: string, timestamp: number, price: number): string {
  return `${type}:${timestamp}:${price.toFixed(5)}`;
}
