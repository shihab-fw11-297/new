import type {
  Candle,
  CandleAuditInfo,
  CandleFetchRequest,
  CandleGap,
  NormalizationResult,
  PriceRange,
  Timeframe,
} from "./types";

const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
};

type NormalizationOptions = {
  timeframe: Timeframe;
  now?: number;
};

type RawRecord = Record<string, unknown>;

export function getTimeframeMs(timeframe: Timeframe): number {
  return TIMEFRAME_MS[timeframe];
}

export function normalizeCandles(
  rawCandles: unknown[],
  options: NormalizationOptions,
): NormalizationResult {
  const now = options.now ?? Date.now();
  const timeframeMs = getTimeframeMs(options.timeframe);
  const parsedCandles: Candle[] = [];
  let invalidCandleCount = 0;

  for (const rawCandle of rawCandles) {
    const candle = normalizeSingleCandle(rawCandle, timeframeMs, now);

    if (!candle) {
      invalidCandleCount += 1;
      continue;
    }

    parsedCandles.push(candle);
  }

  const deduped = dedupeCandles(parsedCandles);
  const sortedCandles = sortCandles(deduped.candles);

  return {
    candles: sortedCandles,
    totalCandlesFetched: rawCandles.length,
    validCandlesCount: sortedCandles.length,
    removedDuplicateCount: deduped.removedDuplicateCount,
    invalidCandleCount,
  };
}

export function dedupeCandles(candles: Candle[]): {
  candles: Candle[];
  removedDuplicateCount: number;
} {
  const byTimestamp = new Map<number, Candle>();
  let removedDuplicateCount = 0;

  for (const candle of candles) {
    if (byTimestamp.has(candle.timestamp)) {
      removedDuplicateCount += 1;
    }

    byTimestamp.set(candle.timestamp, candle);
  }

  return {
    candles: Array.from(byTimestamp.values()),
    removedDuplicateCount,
  };
}

export function sortCandles(candles: Candle[]): Candle[] {
  return [...candles].sort((a, b) => a.timestamp - b.timestamp);
}

export function filterCandlesByDateRange(
  candles: Candle[],
  startDate: string,
  endDate: string,
): Candle[] {
  const startTimestamp = parseDateToTimestamp(startDate);
  const endTimestamp = parseDateToTimestamp(endDate);

  if (startTimestamp === null || endTimestamp === null) {
    return [];
  }

  const startIndex = lowerBoundByTimestamp(candles, startTimestamp);
  const endIndex = upperBoundByTimestamp(candles, endTimestamp);

  return candles.slice(startIndex, endIndex);
}

export function detectCandleGaps(
  candles: Candle[],
  timeframe: Timeframe,
): CandleGap[] {
  const expectedStepMs = getTimeframeMs(timeframe);
  const gaps: CandleGap[] = [];

  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1];
    const current = candles[index];
    const delta = current.timestamp - previous.timestamp;

    if (delta > expectedStepMs * 1.5) {
      gaps.push({
        from: previous.timestamp,
        to: current.timestamp,
        missingCandles: Math.max(1, Math.round(delta / expectedStepMs) - 1),
      });
    }
  }

  return gaps;
}

export function calculateMinMaxPrice(candles: Candle[]): PriceRange {
  if (candles.length === 0) {
    return { min: null, max: null };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const candle of candles) {
    if (candle.low < min) {
      min = candle.low;
    }

    if (candle.high > max) {
      max = candle.high;
    }
  }

  return { min, max };
}

export function buildAuditInfo({
  request,
  normalization,
  gaps,
  priceRange,
  fetchDurationMs,
  cacheStatus,
}: {
  request: CandleFetchRequest;
  normalization: NormalizationResult;
  gaps: CandleGap[];
  priceRange: PriceRange;
  fetchDurationMs: number;
  cacheStatus: "hit" | "miss";
}): CandleAuditInfo {
  const firstCandle = normalization.candles[0];
  const lastCandle = normalization.candles[normalization.candles.length - 1];

  return {
    symbol: request.symbol,
    timeframe: request.timeframe,
    startDate: request.startDate,
    endDate: request.endDate,
    totalCandlesFetched: normalization.totalCandlesFetched,
    validCandlesCount: normalization.validCandlesCount,
    removedDuplicateCount: normalization.removedDuplicateCount,
    invalidCandleCount: normalization.invalidCandleCount,
    firstCandleTime: firstCandle?.time ?? null,
    lastCandleTime: lastCandle?.time ?? null,
    missingCandleGapsCount: gaps.length,
    fetchDurationMs,
    cacheStatus,
    minPrice: priceRange.min,
    maxPrice: priceRange.max,
  };
}

export function validateCandleRequest(
  request: Partial<CandleFetchRequest>,
): string | null {
  if (!request.symbol?.trim()) {
    return "Symbol is required.";
  }

  if (!request.timeframe) {
    return "Timeframe is required.";
  }

  if (!Object.hasOwn(TIMEFRAME_MS, request.timeframe)) {
    return "Unsupported timeframe.";
  }

  if (!request.startDate) {
    return "Start date is required.";
  }

  if (!request.endDate) {
    return "End date is required.";
  }

  const startTimestamp = parseDateToTimestamp(request.startDate);
  const endTimestamp = parseDateToTimestamp(request.endDate);

  if (startTimestamp === null || endTimestamp === null) {
    return "Start date and end date must be valid.";
  }

  if (startTimestamp >= endTimestamp) {
    return "Start date must be before end date.";
  }

  return null;
}

export function createCandleCacheKey(request: CandleFetchRequest): string {
  return [
    request.symbol.trim().toUpperCase(),
    request.timeframe,
    request.startDate,
    request.endDate,
  ].join(":");
}

export function parseDateToTimestamp(value: string): number | null {
  const normalizedValue = normalizeDateInputForUtc(value);
  const timestamp = Date.parse(normalizedValue);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeDateInputForUtc(value: string): string {
  const trimmed = value.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00.000Z`;
  }

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(trimmed)) {
    return `${trimmed}Z`;
  }

  return trimmed;
}

function normalizeSingleCandle(
  rawCandle: unknown,
  timeframeMs: number,
  now: number,
): Candle | null {
  const timestamp = extractTimestamp(rawCandle);
  const open = extractNumber(rawCandle, ["open", "o"], 1);
  const high = extractNumber(rawCandle, ["high", "h"], 2);
  const low = extractNumber(rawCandle, ["low", "l"], 3);
  const close = extractNumber(rawCandle, ["close", "c"], 4);
  const volume = extractNumber(rawCandle, ["volume", "v"], 5) ?? 0;
  const closeTime = extractOptionalTimestamp(rawCandle, [
    "closeTime",
    "close_time",
    "close_time_ms",
  ]);
  const isClosed = inferClosedState(rawCandle, timestamp, closeTime, timeframeMs, now);

  if (
    timestamp === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    timestamp > now ||
    !isClosed ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    low > high
  ) {
    return null;
  }

  return {
    time: new Date(timestamp).toISOString(),
    timestamp,
    open,
    high,
    low,
    close,
    volume,
    closeTime: closeTime ?? undefined,
    isClosed,
  };
}

function extractTimestamp(rawCandle: unknown): number | null {
  return extractOptionalTimestamp(rawCandle, [
    "timestamp",
    "time",
    "datetime",
    "date",
    "t",
    "openTime",
    "open_time",
  ]);
}

function extractOptionalTimestamp(
  rawCandle: unknown,
  keys: string[],
): number | null {
  const rawValue = Array.isArray(rawCandle)
    ? rawCandle[0]
    : getFirstRecordValue(rawCandle, keys);

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return null;
  }

  if (typeof rawValue === "number") {
    return normalizeNumericTimestamp(rawValue);
  }

  if (typeof rawValue === "string") {
    const numericValue = Number(rawValue);

    if (Number.isFinite(numericValue) && rawValue.trim() !== "") {
      return normalizeNumericTimestamp(numericValue);
    }

    const normalizedDate = rawValue.includes("T")
      ? rawValue
      : rawValue.replace(" ", "T");
    const parsedTimestamp = Date.parse(normalizedDate.endsWith("Z")
      ? normalizedDate
      : `${normalizedDate}Z`);

    return Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
  }

  return null;
}

function extractNumber(
  rawCandle: unknown,
  keys: string[],
  arrayIndex: number,
): number | null {
  const rawValue = Array.isArray(rawCandle)
    ? rawCandle[arrayIndex]
    : getFirstRecordValue(rawCandle, keys);

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return null;
  }

  const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

function getFirstRecordValue(rawCandle: unknown, keys: string[]): unknown {
  if (!isRecord(rawCandle)) {
    return undefined;
  }

  for (const key of keys) {
    if (key in rawCandle) {
      return rawCandle[key];
    }
  }

  return undefined;
}

function inferClosedState(
  rawCandle: unknown,
  timestamp: number | null,
  closeTime: number | null,
  timeframeMs: number,
  now: number,
): boolean {
  if (isRecord(rawCandle)) {
    const explicitState = rawCandle.isClosed ?? rawCandle.closed ?? rawCandle.is_closed;

    if (typeof explicitState === "boolean") {
      return explicitState;
    }

    if (typeof explicitState === "string") {
      const normalized = explicitState.toLowerCase();

      if (normalized === "true") {
        return true;
      }

      if (normalized === "false") {
        return false;
      }
    }
  }

  if (closeTime !== null) {
    return closeTime <= now;
  }

  if (timestamp === null) {
    return false;
  }

  return timestamp + timeframeMs <= now;
}

function normalizeNumericTimestamp(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }

  return value < 10_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
}

function lowerBoundByTimestamp(candles: Candle[], target: number): number {
  let left = 0;
  let right = candles.length;

  while (left < right) {
    const middle = Math.floor((left + right) / 2);

    if (candles[middle].timestamp < target) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return left;
}

function upperBoundByTimestamp(candles: Candle[], target: number): number {
  let left = 0;
  let right = candles.length;

  while (left < right) {
    const middle = Math.floor((left + right) / 2);

    if (candles[middle].timestamp <= target) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return left;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
