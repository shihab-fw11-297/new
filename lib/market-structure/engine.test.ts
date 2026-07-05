import { describe, expect, it } from "vitest";

import type { Candle } from "@/lib/candles/types";

import {
  calculateMarketStructure,
  clearMarketStructureCache,
  getDefaultMarketStructureSettings,
  getReplayVisibleMarkers,
  getReplayVisibleZones,
  validateMarkerTiming,
} from "./engine";
import type { MarketMarker, MarketStructureSettings } from "./types";

const baseSettings: MarketStructureSettings = {
  ...getDefaultMarketStructureSettings(),
  sensitivity: "high",
  leftBars: 1,
  rightBars: 1,
  atrPeriod: 2,
  showOnlyMajor: false,
};

describe("market structure engine", () => {
  it("detects swing highs/lows with delayed confirmation", () => {
    const result = run([
      candle(0, 10, 11, 9, 10),
      candle(1, 10, 13, 8, 11),
      candle(2, 10, 11, 9, 10),
    ]);

    const swingHigh = result.markers.find((marker) => marker.type === "SWING_HIGH");
    const swingLow = result.markers.find((marker) => marker.type === "SWING_LOW");

    expect(swingHigh?.sourceIndexes).toEqual([0, 1, 2]);
    expect(swingHigh?.confirmedAtIndex).toBe(2);
    expect(swingLow?.confirmedAtIndex).toBe(2);
  });

  it("creates and merges nearby BSL zones from equal highs", () => {
    const result = run([
      candle(0, 10, 10.4, 9.7, 10),
      candle(1, 10, 12, 9.8, 11),
      candle(2, 10, 10.6, 9.6, 10),
      candle(3, 10, 12.05, 9.7, 11),
      candle(4, 10, 10.5, 9.6, 10),
    ]);

    const bslZones = result.liquidityZones.filter((zone) => zone.type === "BSL");

    expect(bslZones).toHaveLength(1);
    expect(bslZones[0].touches).toBe(2);
  });

  it("creates and merges nearby SSL zones from equal lows", () => {
    const result = run([
      candle(0, 10, 10.6, 9.8, 10.2),
      candle(1, 10, 10.5, 8, 9.4),
      candle(2, 10, 10.7, 9.6, 10.2),
      candle(3, 10, 10.5, 8.05, 9.4),
      candle(4, 10, 10.6, 9.7, 10.2),
    ]);

    const sslZones = result.liquidityZones.filter((zone) => zone.type === "SSL");

    expect(sslZones).toHaveLength(1);
    expect(sslZones[0].touches).toBe(2);
    expect(result.audit.totalEqualLowZones).toBe(1);
  });

  it("detects SSL and BSL sweeps", () => {
    const result = run([
      candle(0, 10, 11, 9.8, 10.4),
      candle(1, 10.5, 11, 9, 10),
      candle(2, 10, 11, 9.7, 10.5),
      candle(3, 10.2, 10.6, 8.7, 9.5),
      candle(4, 10, 11, 9.7, 10.4),
      candle(5, 10, 12, 9.8, 11),
      candle(6, 10, 10.8, 9.7, 10.2),
      candle(7, 10.8, 12.4, 10.4, 11.2),
    ]);

    expect(result.markers.some((marker) => marker.type === "SSL_SWEEP")).toBe(true);
    expect(result.markers.some((marker) => marker.type === "BSL_SWEEP")).toBe(true);
  });

  it("separates close-through sweeps from wick sweeps", () => {
    const result = run([
      candle(0, 10, 10.8, 9.6, 10.2),
      candle(1, 10.2, 10.7, 9, 9.4),
      candle(2, 9.5, 10.6, 9.4, 10.2),
      candle(3, 10, 10.5, 8.55, 8.75),
    ]);

    const sweep = result.markers.find(
      (marker): marker is Extract<MarketMarker, { type: "SSL_SWEEP" | "BSL_SWEEP" }> =>
        marker.type === "SSL_SWEEP" || marker.type === "BSL_SWEEP",
    );

    expect(sweep?.sweepKind).toBe("CLOSE_THROUGH");
  });

  it("does not mark a distant close-through with no rejection as a sweep", () => {
    const result = run([
      candle(0, 10, 10.8, 9.6, 10.2),
      candle(1, 10.2, 10.7, 9, 9.4),
      candle(2, 9.5, 10.6, 9.4, 10.2),
      candle(3, 10, 10.2, 7, 7.1),
    ]);

    expect(result.markers.some((marker) => marker.type === "SSL_SWEEP")).toBe(false);
  });

  it("detects displacement and BUYERS/SELLERS pressure markers", () => {
    const result = run([
      candle(0, 10, 10.4, 9.9, 10.1),
      candle(1, 10.1, 10.5, 10, 10.2),
      candle(2, 10.2, 13, 10.1, 12.8),
      candle(3, 12.8, 13, 12.6, 12.7),
      candle(4, 12.7, 12.8, 9.2, 9.4),
    ]);

    expect(
      result.markers.some((marker) => marker.type === "DISPLACEMENT"),
    ).toBe(true);
    expect(result.markers.some((marker) => marker.type === "BUYERS")).toBe(true);
    expect(result.markers.some((marker) => marker.type === "SELLERS")).toBe(true);
    expect(
      result.markers.every(
        (marker) =>
          (marker.type !== "BUYERS" && marker.type !== "SELLERS") ||
          marker.relatedMomentumId,
      ),
    ).toBe(true);
  });

  it("detects BOS by close beyond a confirmed swing", () => {
    const result = run([
      candle(0, 10, 11, 9.8, 10),
      candle(1, 10, 12, 9.9, 11),
      candle(2, 10.8, 11, 9.8, 10),
      candle(3, 11.5, 12.8, 11.4, 12.4),
    ]);

    expect(result.markers.some((marker) => marker.type === "BOS")).toBe(true);
  });

  it("detects CHOCH after existing opposite structure", () => {
    const result = run([
      candle(0, 10, 11, 9.8, 10),
      candle(1, 10, 12, 9.9, 11),
      candle(2, 10.8, 11, 9.8, 10),
      candle(3, 11.5, 12.8, 11.4, 12.4),
      candle(4, 12, 12.3, 10.5, 11),
      candle(5, 11, 11.4, 9.4, 9.6),
    ]);

    expect(result.markers.some((marker) => marker.type === "CHOCH")).toBe(true);
  });

  it("detects MSS after sweep and displacement", () => {
    const result = run([
      candle(0, 10, 10.8, 9.6, 10.2),
      candle(1, 10.2, 11.4, 9.5, 11),
      candle(2, 10.9, 11, 9.7, 10.2),
      candle(3, 10, 10.4, 9.2, 9.4),
      candle(4, 9.4, 9.8, 8.8, 9.5),
      candle(5, 9.5, 12.2, 9.4, 12),
    ]);

    expect(result.markers.some((marker) => marker.type === "MSS")).toBe(true);
  });

  it("detects FVG only after the next candle closes", () => {
    const result = run([
      candle(0, 10, 10.2, 9.8, 10),
      candle(1, 10, 12, 9.9, 11.8),
      candle(2, 11, 12.4, 10.5, 12),
    ]);
    const fvg = result.markers.find((marker) => marker.type === "FVG");

    expect(fvg?.confirmedAtIndex).toBe(2);
    expect(fvg?.middleIndex).toBe(1);
  });

  it("tracks FVG mitigation without leaking it early in replay", () => {
    const result = run([
      candle(0, 10, 10.2, 9.8, 10),
      candle(1, 10, 12, 9.9, 11.8),
      candle(2, 11, 12.4, 10.5, 12),
      candle(3, 12, 12.2, 10.1, 10.8),
    ]);
    const fvg = result.markers.find((marker) => marker.type === "FVG");
    const replayFvg = getReplayVisibleMarkers(result.markers, 2).find(
      (marker) => marker.type === "FVG",
    );

    expect(fvg?.mitigated).toBe(true);
    expect(replayFvg?.type === "FVG" ? replayFvg.mitigated : null).toBe(false);
  });

  it("prevents future markers from appearing in replay", () => {
    const result = run([
      candle(0, 10, 11, 9, 10),
      candle(1, 10, 13, 8, 11),
      candle(2, 10, 11, 9, 10),
    ]);

    expect(getReplayVisibleMarkers(result.markers, 1)).toHaveLength(0);
    expect(getReplayVisibleMarkers(result.markers, 2).length).toBeGreaterThan(0);
  });

  it("keeps liquidity unswept in replay until the sweep candle", () => {
    const result = run([
      candle(0, 10, 10.8, 9.6, 10.2),
      candle(1, 10.2, 11, 9, 9.4),
      candle(2, 9.5, 10.6, 9.4, 10.2),
      candle(3, 10, 10.5, 8.5, 9.4),
    ]);
    const sslZone = result.liquidityZones.find((zone) => zone.type === "SSL");
    const beforeSweep = getReplayVisibleZones(result.liquidityZones, 2).find(
      (zone) => zone.id === sslZone?.id,
    );
    const afterSweep = getReplayVisibleZones(result.liquidityZones, 3).find(
      (zone) => zone.id === sslZone?.id,
    );

    expect(sslZone?.swept).toBe(true);
    expect(beforeSweep?.swept).toBe(false);
    expect(afterSweep?.swept).toBe(true);
  });

  it("does not count wick-only breaks as BOS", () => {
    const result = run([
      candle(0, 10, 11, 9.8, 10),
      candle(1, 10, 12, 9.9, 11),
      candle(2, 10.8, 11, 9.8, 10),
      candle(3, 11.5, 12.8, 11.4, 11.8),
    ]);

    expect(result.markers.some((marker) => marker.type === "BOS")).toBe(false);
  });

  it("sanitizes unclosed, duplicate, and unsorted candles before marker work", () => {
    const duplicate = candle(1, 10, 13, 8, 11);
    const result = run([
      candle(2, 10, 11, 9, 10),
      { ...candle(3, 10, 12, 9, 11), isClosed: false },
      duplicate,
      candle(0, 10, 11, 9, 10),
      duplicate,
    ]);

    expect(result.candles.map((item) => item.timestamp)).toEqual([
      candle(0, 10, 11, 9, 10).timestamp,
      candle(1, 10, 13, 8, 11).timestamp,
      candle(2, 10, 11, 9, 10).timestamp,
    ]);
  });

  it("passes marker timing validation", () => {
    const result = run([
      candle(0, 10, 11, 9, 10),
      candle(1, 10, 13, 8, 11),
      candle(2, 10, 11, 9, 10),
    ]);

    expect(validateMarkerTiming(result.markers, result.candles)).toEqual([]);
    expect(result.audit.noRepaintValidationStatus).toBe("pass");
  });

  it("does not attach future sweep evidence to earlier pressure markers", () => {
    const result = run([
      candle(0, 100, 101, 99, 100),
      candle(1, 100, 101, 95, 98),
      candle(2, 99, 101, 99, 100),
      candle(3, 100, 106, 99, 105),
      candle(4, 104, 105, 100, 101),
      candle(5, 100, 102, 94, 101),
      candle(6, 101, 102, 99, 100),
    ]);

    const earlyBuyers = result.markers.find(
      (marker): marker is Extract<MarketMarker, { type: "BUYERS" | "SELLERS" }> =>
        (marker.type === "BUYERS" || marker.type === "SELLERS") && marker.confirmedAtIndex === 3,
    );

    expect(earlyBuyers?.relatedSweepId).toBeUndefined();
    expect(result.audit.noRepaintValidationStatus).toBe("pass");
    expect(validateMarkerTiming(result.markers, result.candles)).toEqual([]);
  });

  it("caches marker results by data and settings", () => {
    clearMarketStructureCache();
    const candles = [
      candle(0, 10, 11, 9, 10),
      candle(1, 10, 13, 8, 11),
      candle(2, 10, 11, 9, 10),
    ];

    expect(run(candles).audit.cacheStatus).toBe("miss");
    expect(run(candles).audit.cacheStatus).toBe("hit");
  });
});

function run(candles: Candle[]) {
  return calculateMarketStructure({
    candles,
    symbol: "XAUUSD",
    timeframe: "5m",
    startDate: "2026-05-20",
    endDate: "2026-05-29",
    settings: baseSettings,
  });
}

function candle(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle {
  const timestamp = Date.parse("2026-05-20T00:00:00.000Z") + index * 300_000;

  return {
    time: new Date(timestamp).toISOString(),
    timestamp,
    open,
    high,
    low,
    close,
    volume: 100,
    isClosed: true,
  };
}
