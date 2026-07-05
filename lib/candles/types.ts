export type Candle = {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime?: number;
  isClosed: boolean;
};

export type Timeframe = "1m" | "5m" | "15m" | "1h";

export type CandleFetchRequest = {
  symbol: string;
  timeframe: Timeframe;
  startDate: string;
  endDate: string;
};

export type CandleGap = {
  from: number;
  to: number;
  missingCandles: number;
};

export type PriceRange = {
  min: number | null;
  max: number | null;
};

export type NormalizationResult = {
  candles: Candle[];
  totalCandlesFetched: number;
  validCandlesCount: number;
  removedDuplicateCount: number;
  invalidCandleCount: number;
};

export type CandleAuditInfo = {
  symbol: string;
  timeframe: Timeframe;
  startDate: string;
  endDate: string;
  totalCandlesFetched: number;
  validCandlesCount: number;
  removedDuplicateCount: number;
  invalidCandleCount: number;
  firstCandleTime: string | null;
  lastCandleTime: string | null;
  missingCandleGapsCount: number;
  fetchDurationMs: number;
  cacheStatus: "hit" | "miss";
  minPrice: number | null;
  maxPrice: number | null;
};

export type CandleApiResponse = {
  rawCandles: unknown[];
  provider: string;
  cache: {
    status: "hit" | "miss";
    key: string;
  };
  fetchDurationMs: number;
};
