import type { CandleFetchRequest, Timeframe } from "@/lib/candles/types";
import { getTimeframeMs, parseDateToTimestamp } from "@/lib/candles/utils";

type ProviderChunk = {
  startDate: string;
  endDate: string;
};

const FINAGE_INTERVALS: Record<Timeframe, { multiplier: string; unit: string }> = {
  "1m": { multiplier: "1", unit: "minute" },
  "5m": { multiplier: "5", unit: "minute" },
  "15m": { multiplier: "15", unit: "minute" },
  "1h": { multiplier: "1", unit: "hour" },
};

const TWELVE_DATA_INTERVALS: Record<Timeframe, string> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "1h": "1h",
};

export async function fetchCandles(
  request: CandleFetchRequest,
): Promise<{ rawCandles: unknown[]; provider: string }> {
  const provider = process.env.CANDLE_API_PROVIDER ?? "finage";

  if (provider === "custom") {
    return {
      rawCandles: await fetchCustomCandles(request),
      provider,
    };
  }

  if (provider === "twelvedata") {
    return {
      rawCandles: await fetchTwelveDataCandles(request),
      provider,
    };
  }

  return {
    rawCandles: await fetchFinageCandles(request),
    provider: "finage",
  };
}

async function fetchFinageCandles(
  request: CandleFetchRequest,
): Promise<unknown[]> {
  const apiKey = process.env.CANDLE_API_KEY ?? process.env.FINAGE_API_KEY;

  if (!apiKey) {
    throw new Error("Missing CANDLE_API_KEY or FINAGE_API_KEY.");
  }

  const interval = FINAGE_INTERVALS[request.timeframe];
  const chunks = buildDateChunks(request);
  const candlesByChunk = await Promise.all(
    chunks.map(async (chunk) => {
      const url = new URL(
        `https://api.finage.co.uk/agg/forex/${formatFinageSymbol(
          request.symbol,
        )}/${interval.multiplier}/${interval.unit}/${formatFinageDate(
          chunk.startDate,
        )}/${formatFinageDate(chunk.endDate)}`,
      );

      url.searchParams.set("apikey", apiKey);
      url.searchParams.set("limit", "30000");

      const response = await fetch(url, { cache: "no-store" });
      const payload = await readJsonResponse(response);

      if (isProviderError(payload)) {
        throw new Error(readProviderError(payload));
      }

      return extractRawCandles(payload);
    }),
  );

  return candlesByChunk.flat();
}

async function fetchTwelveDataCandles(
  request: CandleFetchRequest,
): Promise<unknown[]> {
  const apiKey = process.env.CANDLE_API_KEY ?? process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing CANDLE_API_KEY or TWELVE_DATA_API_KEY.");
  }

  const chunks = buildDateChunks(request);
  const candlesByChunk = await Promise.all(
    chunks.map(async (chunk) => {
      const url = new URL("https://api.twelvedata.com/time_series");
      url.searchParams.set("symbol", formatTwelveDataSymbol(request.symbol));
      url.searchParams.set("interval", TWELVE_DATA_INTERVALS[request.timeframe]);
      url.searchParams.set("start_date", formatProviderDate(chunk.startDate));
      url.searchParams.set("end_date", formatProviderDate(chunk.endDate));
      url.searchParams.set("order", "ASC");
      url.searchParams.set("timezone", "UTC");
      url.searchParams.set("format", "JSON");
      url.searchParams.set("outputsize", String(getMaxCandlesPerRequest()));
      url.searchParams.set("apikey", apiKey);

      const response = await fetch(url, { cache: "no-store" });
      const payload = await readJsonResponse(response);

      if (isProviderError(payload)) {
        throw new Error(readProviderError(payload));
      }

      return extractRawCandles(payload);
    }),
  );

  return candlesByChunk.flat();
}

async function fetchCustomCandles(
  request: CandleFetchRequest,
): Promise<unknown[]> {
  const endpoint = process.env.CANDLE_API_URL;

  if (!endpoint) {
    throw new Error("Missing CANDLE_API_URL for custom candle provider.");
  }

  const chunks = buildDateChunks(request);
  const apiKey = process.env.CANDLE_API_KEY;
  const authHeader = process.env.CANDLE_API_KEY_HEADER ?? "Authorization";
  const authValue =
    authHeader.toLowerCase() === "authorization" && apiKey
      ? `Bearer ${apiKey}`
      : apiKey;

  const candlesByChunk = await Promise.all(
    chunks.map(async (chunk) => {
      const url = new URL(endpoint);
      url.searchParams.set("symbol", request.symbol);
      url.searchParams.set("timeframe", request.timeframe);
      url.searchParams.set("startDate", chunk.startDate);
      url.searchParams.set("endDate", chunk.endDate);

      const headers: HeadersInit = {};

      if (authValue) {
        headers[authHeader] = authValue;
      }

      const response = await fetch(url, {
        cache: "no-store",
        headers,
      });
      const payload = await readJsonResponse(response);

      if (isProviderError(payload)) {
        throw new Error(readProviderError(payload));
      }

      return extractRawCandles(payload);
    }),
  );

  return candlesByChunk.flat();
}

function buildDateChunks(request: CandleFetchRequest): ProviderChunk[] {
  const startTimestamp = parseDateToTimestamp(request.startDate);
  const endTimestamp = parseDateToTimestamp(request.endDate);

  if (startTimestamp === null || endTimestamp === null) {
    return [{ startDate: request.startDate, endDate: request.endDate }];
  }

  const maxCandles = getMaxCandlesPerRequest();
  const maxChunkMs = getTimeframeMs(request.timeframe) * maxCandles;
  const chunks: ProviderChunk[] = [];

  let chunkStart = startTimestamp;

  while (chunkStart < endTimestamp) {
    const chunkEnd = Math.min(chunkStart + maxChunkMs, endTimestamp);

    chunks.push({
      startDate: new Date(chunkStart).toISOString(),
      endDate: new Date(chunkEnd).toISOString(),
    });

    chunkStart = chunkEnd + getTimeframeMs(request.timeframe);
  }

  return chunks;
}

function getMaxCandlesPerRequest(): number {
  const configuredValue = Number(process.env.CANDLE_API_MAX_POINTS ?? 30000);
  return Number.isFinite(configuredValue) && configuredValue > 0
    ? Math.trunc(configuredValue)
    : 30000;
}

function formatFinageSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace("/", "");
}

function formatFinageDate(value: string): string {
  const timestamp = parseDateToTimestamp(value);

  if (timestamp === null) {
    return value.slice(0, 10);
  }

  return new Date(timestamp).toISOString().slice(0, 10);
}

function formatTwelveDataSymbol(symbol: string): string {
  const normalizedSymbol = symbol.trim().toUpperCase();

  if (normalizedSymbol.includes("/")) {
    return normalizedSymbol;
  }

  if (/^[A-Z]{6}$/.test(normalizedSymbol)) {
    return `${normalizedSymbol.slice(0, 3)}/${normalizedSymbol.slice(3)}`;
  }

  return normalizedSymbol;
}

function formatProviderDate(value: string): string {
  const timestamp = parseDateToTimestamp(value);

  if (timestamp === null) {
    return value;
  }

  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(`Candle provider returned HTTP ${response.status}.`);
  }

  return payload;
}

function extractRawCandles(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!isRecord(payload)) {
    return [];
  }

  const candidates = [
    payload.values,
    payload.candles,
    payload.data,
    payload.results,
    payload.result,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function isProviderError(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }

  return (
    String(payload.status ?? "").toLowerCase() === "error" ||
    String(payload.status ?? "").toUpperCase() === "ERROR" ||
    typeof payload.code === "number" ||
    typeof payload.error === "string" ||
    isRecord(payload.error)
  );
}

function readProviderError(payload: unknown): string {
  if (!isRecord(payload)) {
    return "Candle provider returned an error.";
  }

  const message = payload.message ?? payload.error;

  if (typeof message === "string") {
    return message;
  }

  if (isRecord(message) && typeof message.message === "string") {
    return message.message;
  }

  return "Candle provider returned an error.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
