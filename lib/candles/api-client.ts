import type { CandleApiResponse, CandleFetchRequest } from "./types";

export async function fetchCandles(
  request: CandleFetchRequest,
  signal?: AbortSignal,
): Promise<CandleApiResponse> {
  const response = await fetch("/api/candles", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
    signal,
  });

  const payload = (await response.json()) as
    | CandleApiResponse
    | { error?: string };

  if (!response.ok) {
    throw new Error(
      "error" in payload && payload.error
        ? payload.error
        : "Unable to fetch candles.",
    );
  }

  return payload as CandleApiResponse;
}
