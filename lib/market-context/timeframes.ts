import type { Candle, Timeframe } from "../candles/types";

import type { AggregatedCandle, CandleTimeContext, ContextTimeframe, TimeframeMapping } from "./types";

const TIMEFRAME_MS: Record<ContextTimeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

const MAPPINGS: Record<Timeframe, TimeframeMapping> = {
  "1m": { ltf: "1m", itf: "5m", htf: "15m", modeName: "1M SCALPING" },
  "5m": { ltf: "5m", itf: "15m", htf: "1h", modeName: "5M SCALPING" },
  "15m": { ltf: "15m", itf: "1h", htf: "4h", modeName: "15M INTRADAY" },
  "1h": { ltf: "1h", itf: "4h", htf: "1d", modeName: "1H SWING" },
};

const aggregationCache = new Map<string, AggregatedCandle[]>();

export function getTimeframeMapping(selectedTimeframe: Timeframe): TimeframeMapping {
  return { ...MAPPINGS[selectedTimeframe] };
}

export function getContextTimeframeMs(timeframe: ContextTimeframe): number {
  return TIMEFRAME_MS[timeframe];
}

export function aggregateCandles(
  candles: Candle[],
  sourceTimeframe: ContextTimeframe,
  targetTimeframe: ContextTimeframe,
  cacheNamespace = "default",
): AggregatedCandle[] {
  const sourceMs = TIMEFRAME_MS[sourceTimeframe];
  const targetMs = TIMEFRAME_MS[targetTimeframe];
  if (targetMs <= sourceMs || targetMs % sourceMs !== 0) return [];

  const key = `${cacheNamespace}:${sourceTimeframe}:${targetTimeframe}:${fingerprint(candles)}`;
  const cached = aggregationCache.get(key);
  if (cached) return cached;

  const expectedCount = targetMs / sourceMs;
  const buckets = new Map<number, Array<{ candle: Candle; index: number }>>();
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index];
    if (!candle.isClosed) continue;
    const bucket = Math.floor(candle.timestamp / targetMs) * targetMs;
    const group = buckets.get(bucket) ?? [];
    group.push({ candle, index });
    buckets.set(bucket, group);
  }

  const result: AggregatedCandle[] = [];
  for (const [bucketStart, group] of buckets) {
    group.sort((a, b) => a.candle.timestamp - b.candle.timestamp);
    const complete =
      group.length === expectedCount &&
      group[0].candle.timestamp === bucketStart &&
      group.every((entry, index) => entry.candle.timestamp === bucketStart + index * sourceMs);
    if (!complete) continue;

    let high = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    let volume = 0;
    for (const { candle } of group) {
      high = Math.max(high, candle.high);
      low = Math.min(low, candle.low);
      volume += candle.volume;
    }
    result.push({
      time: new Date(bucketStart).toISOString(),
      timestamp: bucketStart,
      open: group[0].candle.open,
      high,
      low,
      close: group.at(-1)!.candle.close,
      volume,
      closeTime: bucketStart + targetMs,
      isClosed: true,
      sourceStartIndex: group[0].index,
      sourceEndIndex: group.at(-1)!.index,
    });
  }
  result.sort((a, b) => a.timestamp - b.timestamp);
  aggregationCache.set(key, result);
  return result;
}

export function getContextForCandleTime(
  timestamp: number,
  ltfCandles: Candle[],
  itfCandles: AggregatedCandle[],
  htfCandles: AggregatedCandle[],
): CandleTimeContext {
  const ltfIndex = upperBound(ltfCandles, timestamp, (candle) => candle.timestamp) - 1;
  const itfIndex = upperBound(itfCandles, timestamp, (candle) => candle.closeTime) - 1;
  const htfIndex = upperBound(htfCandles, timestamp, (candle) => candle.closeTime) - 1;
  const ltfCandle = ltfIndex >= 0 ? ltfCandles[ltfIndex] : null;
  const latestClosedItfCandle = itfIndex >= 0 ? itfCandles[itfIndex] : null;
  const latestClosedHtfCandle = htfIndex >= 0 ? htfCandles[htfIndex] : null;
  return {
    ltfCandle,
    latestClosedItfCandle,
    latestClosedHtfCandle,
    validContext: Boolean(ltfCandle && latestClosedItfCandle && latestClosedHtfCandle),
  };
}

export function clearAggregationCache(): void {
  aggregationCache.clear();
}

function upperBound<T>(items: T[], value: number, read: (item: T) => number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (read(items[middle]) <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function fingerprint(candles: Candle[]): string {
  const first = candles[0];
  const last = candles.at(-1);
  return `${candles.length}:${first?.timestamp ?? 0}:${last?.timestamp ?? 0}:${last?.close ?? 0}`;
}
