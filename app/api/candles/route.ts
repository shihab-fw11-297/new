import { type CandleApiResponse, type CandleFetchRequest } from "@/lib/candles/types";
import {
  createCandleCacheKey,
  validateCandleRequest,
} from "@/lib/candles/utils";
import { fetchCandles } from "@/lib/server/candle-provider";

export const dynamic = "force-dynamic";

type CachedCandles = Omit<CandleApiResponse, "fetchDurationMs" | "cache"> & {
  createdAt: number;
};

const requestCache = new Map<string, CachedCandles>();
const CACHE_TTL_MS = 60_000;

export async function POST(request: Request) {
  const startedAt = performance.now();

  let payload: Partial<CandleFetchRequest>;

  try {
    payload = (await request.json()) as Partial<CandleFetchRequest>;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const validationError = validateCandleRequest(payload);

  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 });
  }

  const candleRequest: CandleFetchRequest = {
    symbol: payload.symbol!.trim().toUpperCase(),
    timeframe: payload.timeframe!,
    startDate: payload.startDate!,
    endDate: payload.endDate!,
  };
  const cacheKey = createCandleCacheKey(candleRequest);
  const cachedCandles = requestCache.get(cacheKey);

  if (cachedCandles && Date.now() - cachedCandles.createdAt < CACHE_TTL_MS) {
    return Response.json({
      rawCandles: cachedCandles.rawCandles,
      provider: cachedCandles.provider,
      cache: {
        status: "hit",
        key: cacheKey,
      },
      fetchDurationMs: Math.round(performance.now() - startedAt),
    } satisfies CandleApiResponse);
  }

  try {
    const result = await fetchCandles(candleRequest);

    requestCache.set(cacheKey, {
      ...result,
      createdAt: Date.now(),
    });

    return Response.json({
      ...result,
      cache: {
        status: "miss",
        key: cacheKey,
      },
      fetchDurationMs: Math.round(performance.now() - startedAt),
    } satisfies CandleApiResponse);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to fetch candles.";

    return Response.json({ error: message }, { status: 502 });
  }
}
