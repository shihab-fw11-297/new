import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/candles/types";

import { analyzeCandleReading, classifyCandle } from "./engine";

describe("candle reading engine", () => {
  it("classifies a strong bullish candle", () => {
    const reading = classifyCandle(candle(1, 10, 19, 9, 18), undefined, 10);
    expect(reading.classifications).toContain("STRONG_BULLISH");
    expect(reading.control).toBe("BUYERS");
  });

  it("classifies a strong bearish candle", () => {
    const reading = classifyCandle(candle(1, 18, 19, 9, 10), undefined, 10);
    expect(reading.classifications).toContain("STRONG_BEARISH");
    expect(reading.control).toBe("SELLERS");
  });

  it("classifies a doji", () => {
    const reading = classifyCandle(candle(1, 10, 12, 8, 10.1), undefined, 4);
    expect(reading.primaryType).toBe("DOJI");
  });

  it("classifies bullish and bearish pin bars", () => {
    const bullish = classifyCandle(candle(1, 10, 10.8, 6, 10.5), undefined, 4.8);
    const bearish = classifyCandle(candle(2, 10, 14, 9.2, 9.5), undefined, 4.8);
    expect(bullish.classifications).toContain("PIN_BAR_BULLISH");
    expect(bearish.classifications).toContain("PIN_BAR_BEARISH");
  });

  it("classifies bullish and bearish engulfing candles", () => {
    const bearishPrevious = candle(0, 11, 11.2, 9.3, 9.5);
    const bullish = classifyCandle(
      candle(1, 9.4, 11.4, 9.2, 11.2),
      bearishPrevious,
      2,
    );
    const bullishPrevious = candle(2, 9.5, 11.2, 9.3, 11);
    const bearish = classifyCandle(
      candle(3, 11.1, 11.3, 9.1, 9.4),
      bullishPrevious,
      2,
    );
    expect(bullish.classifications).toContain("ENGULFING_BULLISH");
    expect(bearish.classifications).toContain("ENGULFING_BEARISH");
  });

  it("classifies an inside bar", () => {
    const previous = candle(0, 10, 13, 7, 11);
    const reading = classifyCandle(candle(1, 10, 12, 8, 11), previous, 5);
    expect(reading.classifications).toContain("INSIDE_BAR");
  });

  it("classifies an outside bar", () => {
    const previous = candle(0, 10, 12, 8, 11);
    const reading = classifyCandle(candle(1, 11, 13, 7, 10), previous, 5);
    expect(reading.classifications).toContain("OUTSIDE_BAR");
  });

  it("reads a bullish candle sequence", () => {
    const result = analyzeCandleReading(trendingCandles("BULLISH"));
    expect(result?.sequence.shortTermFlow).toBe("BULLISH");
    expect(result?.sequence.pressure).toBe("BUYERS_ACTIVE");
  });

  it("reads a bearish candle sequence", () => {
    const result = analyzeCandleReading(trendingCandles("BEARISH"));
    expect(result?.sequence.shortTermFlow).toBe("BEARISH");
    expect(result?.sequence.pressure).toBe("SELLERS_ACTIVE");
  });

  it("detects range compression", () => {
    const candles = rangeShiftCandles(2, 0.4);
    const result = analyzeCandleReading(candles);
    expect(result?.sequence.volatilityState).toBe("CONTRACTING");
    expect(result?.sequence.features).toContain("compression");
  });

  it("detects range expansion", () => {
    const candles = rangeShiftCandles(0.4, 2);
    const result = analyzeCandleReading(candles);
    expect(result?.sequence.volatilityState).toBe("EXPANDING");
    expect(result?.sequence.features).toContain("expansion");
  });

  it("raises high reversal risk after an extended candle", () => {
    const candles = trendingCandles("BULLISH").slice(0, 14);
    candles.push(candle(14, 24, 34, 23.8, 25));
    const result = analyzeCandleReading(candles, { atrPeriod: 14 });
    expect(result?.reversalWarning.reversalRisk).toBe("HIGH");
    expect(result?.reversalWarning.avoidChasing).toBe(true);
  });

  it("builds three conditional next-candle scenarios", () => {
    const result = analyzeCandleReading(trendingCandles("BULLISH"));
    expect(result).not.toBeNull();
    const scenarios = result!.scenarios;
    expect(
      scenarios.bullishScenario.probability +
        scenarios.bearishScenario.probability +
        scenarios.neutralScenario.probability,
    ).toBe(100);
    expect(scenarios.bullishScenario.condition).toContain("close");
    expect(scenarios.bearishScenario.invalidation).toBeTypeOf("number");
  });

  it("does not generate a future candle", () => {
    const result = analyzeCandleReading(trendingCandles("BULLISH"))!;
    expect(result.candles).toHaveLength(15);
    expect(result.windowEndTimestamp).toBe(result.candles.at(-1)?.timestamp);
    expect(result.scenarios).not.toHaveProperty("futureCandle");
    expect(result.scenarios).not.toHaveProperty("open");
    expect(result.scenarios).not.toHaveProperty("close");
  });

  it("does not generate entry or BUY/SELL signal fields", () => {
    const result = analyzeCandleReading(trendingCandles("BEARISH"))!;
    const keys = collectKeys(result).map((key) => key.toLowerCase());
    expect(keys).not.toContain("signal");
    expect(keys).not.toContain("entry");
    expect(keys).not.toContain("buysignal");
    expect(keys).not.toContain("sellsignal");
  });

  it("ignores open and future candles", () => {
    const candles = trendingCandles("BULLISH");
    candles.push({ ...candle(15, 25, 26, 24, 25.5), isClosed: false });
    candles.push({
      ...candle(16, 26, 27, 25, 26.5),
      timestamp: Date.now() + 60_000,
      time: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = analyzeCandleReading(candles)!;
    expect(result.windowEndTimestamp).toBe(candles[14].timestamp);
  });
});

function trendingCandles(direction: "BULLISH" | "BEARISH"): Candle[] {
  return Array.from({ length: 15 }, (_, index) => {
    if (direction === "BULLISH") {
      const open = 10 + index;
      return candle(index, open, open + 1.1, open - 0.2, open + 0.9);
    }
    const open = 30 - index;
    return candle(index, open, open + 0.2, open - 1.1, open - 0.9);
  });
}

function rangeShiftCandles(priorRange: number, recentRange: number): Candle[] {
  return Array.from({ length: 15 }, (_, index) => {
    const range = index < 10 ? priorRange : recentRange;
    const center = 20 + Math.sin(index) * 0.05;
    const open = center - range * 0.2;
    const close = center + range * 0.2;
    return candle(index, open, center + range / 2, center - range / 2, close);
  });
}

function candle(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  const timestamp = Date.UTC(2024, 0, 1, 0, index);
  return {
    time: new Date(timestamp).toISOString(),
    timestamp,
    open,
    high,
    low,
    close,
    volume: 100 + index,
    closeTime: timestamp + 59_999,
    isClosed: true,
  };
}

function collectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const keys: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    keys.push(...collectKeys(child));
  }
  return keys;
}
