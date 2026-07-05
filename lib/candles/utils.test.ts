import { describe, expect, it } from "vitest";

import type { Candle } from "./types";
import {
  detectCandleGaps,
  filterCandlesByDateRange,
  normalizeCandles,
  parseDateToTimestamp,
} from "./utils";

const NOW = Date.parse("2024-01-01T01:00:00.000Z");

describe("candle utilities", () => {
  it("normalizes valid candles into the app candle shape", () => {
    const result = normalizeCandles(
      [
        {
          datetime: "2024-01-01 00:00:00",
          open: "2050.1",
          high: "2051.2",
          low: "2049.8",
          close: "2050.9",
          volume: "120",
        },
      ],
      { timeframe: "1m", now: NOW },
    );

    expect(result.candles).toEqual([
      {
        time: "2024-01-01T00:00:00.000Z",
        timestamp: Date.parse("2024-01-01T00:00:00.000Z"),
        open: 2050.1,
        high: 2051.2,
        low: 2049.8,
        close: 2050.9,
        volume: 120,
        closeTime: undefined,
        isClosed: true,
      },
    ]);
    expect(result.invalidCandleCount).toBe(0);
  });

  it("removes duplicates by timestamp", () => {
    const result = normalizeCandles(
      [
        candle("2024-01-01T00:00:00.000Z", 10),
        candle("2024-01-01T00:00:00.000Z", 11),
      ],
      { timeframe: "1m", now: NOW },
    );

    expect(result.candles).toHaveLength(1);
    expect(result.candles[0].open).toBe(11);
    expect(result.removedDuplicateCount).toBe(1);
  });

  it("sorts candles by timestamp ascending", () => {
    const result = normalizeCandles(
      [
        candle("2024-01-01T00:02:00.000Z", 12),
        candle("2024-01-01T00:00:00.000Z", 10),
        candle("2024-01-01T00:01:00.000Z", 11),
      ],
      { timeframe: "1m", now: NOW },
    );

    expect(result.candles.map((item) => item.open)).toEqual([10, 11, 12]);
  });

  it("filters candles by date range with binary-search boundaries", () => {
    const candles = [
      normalized("2024-01-01T00:00:00.000Z", 10),
      normalized("2024-01-01T00:01:00.000Z", 11),
      normalized("2024-01-01T00:02:00.000Z", 12),
    ];

    expect(
      filterCandlesByDateRange(
        candles,
        "2024-01-01T00:01:00.000Z",
        "2024-01-01T00:02:00.000Z",
      ).map((item) => item.open),
    ).toEqual([11, 12]);
  });

  it("parses datetime-local inputs as UTC chart times", () => {
    expect(parseDateToTimestamp("2026-05-20T00:00")).toBe(
      Date.parse("2026-05-20T00:00:00.000Z"),
    );
    expect(parseDateToTimestamp("2026-05-20")).toBe(
      Date.parse("2026-05-20T00:00:00.000Z"),
    );
  });

  it("detects missing candle gaps", () => {
    const candles = [
      normalized("2024-01-01T00:00:00.000Z", 10),
      normalized("2024-01-01T00:03:00.000Z", 13),
    ];

    expect(detectCandleGaps(candles, "1m")).toEqual([
      {
        from: Date.parse("2024-01-01T00:00:00.000Z"),
        to: Date.parse("2024-01-01T00:03:00.000Z"),
        missingCandles: 2,
      },
    ]);
  });

  it("rejects invalid and future candles", () => {
    const result = normalizeCandles(
      [
        candle("2024-01-01T00:00:00.000Z", Number.NaN),
        {
          ...candle("2024-01-01T00:01:00.000Z", 10),
          high: 9,
        },
        candle("2024-01-01T02:00:00.000Z", 12),
      ],
      { timeframe: "1m", now: NOW },
    );

    expect(result.candles).toHaveLength(0);
    expect(result.invalidCandleCount).toBe(3);
  });
});

function candle(time: string, open: number) {
  return {
    time,
    open,
    high: open + 1,
    low: open - 1,
    close: open + 0.5,
    volume: 100,
  };
}

function normalized(time: string, open: number): Candle {
  const timestamp = Date.parse(time);

  return {
    time,
    timestamp,
    open,
    high: open + 1,
    low: open - 1,
    close: open + 0.5,
    volume: 100,
    isClosed: true,
  };
}
