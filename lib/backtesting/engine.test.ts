import { beforeEach, describe, expect, it } from "vitest";

import type { Candle } from "../candles/types";
import type { TradeSignal } from "../entry-engine/types";
import type { RejectedSetup } from "../entry-engine/types";
import {
  calculateMaxDrawdown,
  calculatePerformanceMetrics,
  clearBacktestCache,
  runBacktest,
  simulatePropFirm,
} from "./engine";

describe("Phase 7 backtesting engine", () => {
  beforeEach(clearBacktestCache);

  it("uses confirmed Phase 5 signals and validates no future signal evidence", () => {
    const result = runBacktest({ ...baseInput(), signals: [signalFixture()] });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].signalId).toBe("signal-buy");
    expect(result.trades[0].noFutureValidation).toMatchObject({
      signalId: "signal-buy",
      confirmedAtIndex: 1,
      maxDataIndexUsedForSignal: 1,
      passedNoFutureCheck: true,
    });
  });

  it("does not evaluate results before the signal confirmation candle", () => {
    const result = runBacktest({
      ...baseInput(),
      candles: [
        candle(0, 100, 101, 99, 100),
        candle(1, 100, 100.4, 99.8, 100),
        candle(2, 100, 101.2, 99.9, 101),
      ],
      signals: [signalFixture()],
    });
    expect(result.trades[0].entryIndex).toBe(1);
    expect(result.trades[0].exitIndex).toBe(2);
    expect(result.trades[0].result).toBe("WIN");
  });

  it("calculates a BUY win result", () => {
    const result = runBacktest({ ...baseInput(), signals: [signalFixture()] });
    expect(result.trades[0]).toMatchObject({ result: "WIN", finalR: 1 });
  });

  it("calculates a BUY loss result", () => {
    const result = runBacktest({
      ...baseInput(),
      candles: [candle(0, 100, 100.5, 99.5, 100), candle(1, 100, 100.3, 99.7, 100), candle(2, 100, 100.2, 98.8, 99)],
      signals: [signalFixture()],
    });
    expect(result.trades[0]).toMatchObject({ result: "LOSS", finalR: -1 });
  });

  it("calculates a SELL win result", () => {
    const result = runBacktest({
      ...baseInput(),
      candles: [candle(0, 100, 101, 99, 100), candle(1, 100, 100.3, 99.7, 100), candle(2, 100, 100.1, 98.7, 99)],
      signals: [signalFixture({ id: "signal-sell", direction: "BEARISH", entryPrice: 100, stopLoss: 101, takeProfit: 99, type: "CONFIRMED_SELL" })],
    });
    expect(result.trades[0]).toMatchObject({ result: "WIN", finalR: 1 });
  });

  it("calculates a SELL loss result", () => {
    const result = runBacktest({
      ...baseInput(),
      candles: [candle(0, 100, 101, 99, 100), candle(1, 100, 100.3, 99.7, 100), candle(2, 100, 101.2, 99.9, 101)],
      signals: [signalFixture({ id: "signal-sell", direction: "BEARISH", entryPrice: 100, stopLoss: 101, takeProfit: 99, type: "CONFIRMED_SELL" })],
    });
    expect(result.trades[0]).toMatchObject({ result: "LOSS", finalR: -1 });
  });

  it("uses conservative same-candle TP/SL handling", () => {
    const result = runBacktest({
      ...baseInput(),
      candles: [candle(0, 100, 100.5, 99.5, 100), candle(1, 100, 100.3, 99.7, 100), candle(2, 100, 101.2, 98.8, 100.2)],
      signals: [signalFixture()],
      settings: { sameCandlePolicy: "CONSERVATIVE_SL_FIRST", enablePartials: false, enableBreakeven: false },
    });
    expect(result.trades[0].result).toBe("LOSS");
  });

  it("can mark same-candle ambiguity as unknown", () => {
    const result = runBacktest({
      ...baseInput(),
      candles: [candle(0, 100, 100.5, 99.5, 100), candle(1, 100, 100.3, 99.7, 100), candle(2, 100, 101.2, 98.8, 100.2)],
      signals: [signalFixture()],
      settings: { sameCandlePolicy: "MARK_UNKNOWN", enablePartials: false, enableBreakeven: false },
    });
    expect(result.trades[0].result).toBe("UNKNOWN_INTRACANDLE");
  });

  it("calculates breakeven after price reaches 1R then returns to entry", () => {
    const result = runBacktest({
      ...baseInput(),
      candles: [candle(0, 100, 100.5, 99.5, 100), candle(1, 100, 100.3, 99.7, 100), candle(2, 100, 101.1, 100.1, 100.8), candle(3, 100.7, 100.8, 100, 100.1)],
      signals: [signalFixture({ takeProfit: 103, rr: 3 })],
      settings: { enableBreakeven: true, enablePartials: false },
    });
    expect(result.trades[0].result).toBe("BREAKEVEN");
  });

  it("calculates partial TP result", () => {
    const result = runBacktest({
      ...baseInput(),
      candles: [candle(0, 100, 100.5, 99.5, 100), candle(1, 100, 100.3, 99.7, 100), candle(2, 100, 102.2, 100.1, 101.8), candle(3, 101.8, 101.9, 100, 100.2)],
      signals: [signalFixture({ takeProfit: 102, takeProfit2: 104, rr: 2 })],
      settings: { enablePartials: true, enableBreakeven: true },
    });
    expect(result.trades[0].result).toBe("PARTIAL_WIN");
    expect(result.trades[0].finalR).toBeGreaterThan(0);
  });

  it("calculates expectancy and profit factor", () => {
    const metrics = calculatePerformanceMetrics([
      trade("a", 1, 50),
      trade("b", -1, -50),
      trade("c", 2, 100),
    ]);
    expect(metrics.expectancy).toBeCloseTo(0.667, 3);
    expect(metrics.profitFactor).toBe(3);
  });

  it("calculates max drawdown", () => {
    expect(calculateMaxDrawdown([trade("a", 1, 100), trade("b", -2, -200), trade("c", 1, 100)], 10_000)).toBe(200);
  });

  it("builds session and setup type breakdowns", () => {
    const result = runBacktest({ ...baseInput(), signals: [signalFixture()] });
    expect(result.breakdowns.bySession[0]).toMatchObject({ key: "LONDON", totalTrades: 1 });
    expect(result.breakdowns.bySetupType[0]).toMatchObject({ key: "LIQUIDITY_SWEEP_REVERSAL", totalTrades: 1 });
  });

  it("builds rejection histogram and missed opportunity counts", () => {
    const result = runBacktest({
      ...baseInput(),
      rejectedSetups: [rejected("RR_TOO_LOW"), rejected("RR_TOO_LOW"), rejected("HIGH_REVERSAL")],
    });
    expect(result.rejectionAnalytics.rejectionHistogram[0]).toEqual({ reason: "RR_TOO_LOW", count: 2 });
    expect(result.rejectionAnalytics.rejectedButLaterWouldHaveWonCount).toBeGreaterThanOrEqual(0);
  });

  it("runs calibration comparison sets", () => {
    const result = runBacktest({ ...baseInput(), signals: [signalFixture({ score: 62, rr: 1.2 })] });
    expect(result.calibration.map((item) => item.settingName)).toEqual(["current settings", "relaxed settings", "strict settings", "custom settings"]);
    expect(result.calibration.find((item) => item.settingName === "relaxed settings")?.totalTrades).toBe(1);
  });

  it("fails prop firm rules on daily drawdown", () => {
    const prop = simulatePropFirm([trade("a", -12, -600)], { startingBalance: 10_000, profitTargetPercent: 8, maxDailyLossPercent: 5, maxTotalDrawdownPercent: 10, maxTradesPerDay: 2, minTradingDays: 1, consistencyRulePercent: 50 });
    expect(prop.dailyDrawdownHit).toBe(true);
    expect(prop.passed).toBe(false);
  });

  it("passes prop firm rules when target and trading-day constraints are met", () => {
    const prop = simulatePropFirm([trade("a", 4, 400), trade("b", 4, 400)], { startingBalance: 10_000, profitTargetPercent: 8, maxDailyLossPercent: 5, maxTotalDrawdownPercent: 10, maxTradesPerDay: 2, minTradingDays: 1, consistencyRulePercent: 100 });
    expect(prop.profitTargetHit).toBe(true);
    expect(prop.passed).toBe(true);
  });

  it("memoizes identical backtests", () => {
    const input = { ...baseInput(), signals: [signalFixture()] };
    expect(runBacktest(input).audit.cacheStatus).toBe("miss");
    expect(runBacktest(input).audit.cacheStatus).toBe("hit");
  });
});

function baseInput() {
  return {
    candles: [candle(0, 100, 100.5, 99.5, 100), candle(1, 100, 100.3, 99.7, 100), candle(2, 100, 101.2, 99.9, 101)],
    signals: [] as TradeSignal[],
    rejectedSetups: [] as RejectedSetup[],
    symbol: "XAUUSD",
    timeframe: "5m" as const,
    startDate: "2026-05-20T00:00",
    endDate: "2026-05-20T01:00",
    settings: { signalMode: "NORMAL_SCALP" as const, accountBalance: 10_000, riskPerTradePercent: 0.5, enablePartials: false, enableBreakeven: false },
    marketRegime: "TRENDING_BULLISH" as const,
  };
}

function signalFixture(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: "signal-buy",
    type: "CONFIRMED_BUY",
    direction: "BULLISH",
    status: "CONFIRMED",
    sourceSetupId: "setup-1",
    setupType: "LIQUIDITY_SWEEP_REVERSAL",
    strategyModel: "Liquidity Sweep Reversal",
    mode: "NORMAL_SCALP",
    timestamp: candle(1, 100, 100.3, 99.7, 100).timestamp,
    candleIndex: 1,
    confirmedAtIndex: 1,
    timeframe: "5m",
    session: "LONDON",
    entryPrice: 100,
    stopLoss: 99,
    takeProfit: 101,
    takeProfit2: null,
    takeProfit3: null,
    riskPoints: 1,
    rewardPoints: 1,
    rr: 1,
    score: 80,
    confidence: "STRONG",
    positionSizeSuggestion: 50,
    maxRiskAmount: 100,
    invalidationLevel: 99,
    reasons: ["Phase 5 confirmed signal."],
    warnings: [],
    rejectionReasons: [],
    relatedMarkers: ["marker-1"],
    noRepaintProof: { status: "PASS", signalIndex: 1, latestAllowedCandleIndex: 1, usedMarkerIndexes: [1], usedContextCloseTimes: [], usedSetupId: "setup-1", passed: true, lastAvailableIndex: 1, maxEvidenceIndex: 1, message: "pass" },
    stopLossDetail: { price: 99, source: "SWEEP_EXTREME", buffer: 0, riskPoints: 1, reason: "stop" },
    takeProfitDetail: { tp1: 101, tp2: null, tp3: null, source: "BSL", rewardPoints: 1, reason: "target" },
    scoreBreakdown: { phase4Setup: 20, contextAlignment: 10, confirmationCandle: 10, stopLossQuality: 10, targetQuality: 10, sessionQuality: 5, volatilityQuality: 5, antiReversal: 10 },
    ...overrides,
  };
}

function rejected(reason: string): RejectedSetup {
  return {
    setupId: `rejected-${reason}`,
    setupType: "LIQUIDITY_SWEEP_REVERSAL",
    setupState: "TRIGGER",
    direction: "BULLISH",
    triggerIndex: 1,
    rejectionReasons: [reason],
    rejectionReasonCodes: [reason === "RR_TOO_LOW" ? "RR_TOO_LOW" : "REVERSAL_RISK_HIGH"],
  };
}

function trade(id: string, finalR: number, pnl: number) {
  const base = signalFixture({ id });
  return {
    tradeId: id,
    signalId: id,
    direction: base.direction,
    setupType: base.setupType,
    session: base.session,
    mode: "NORMAL_SCALP" as const,
    symbol: "XAUUSD",
    timeframe: "5m" as const,
    entryTime: base.timestamp,
    exitTime: base.timestamp + 300_000,
    entryIndex: 1,
    exitIndex: 2,
    entryPrice: 100,
    stopLoss: 99,
    takeProfit: 101,
    takeProfit2: null,
    takeProfit3: null,
    rr: 1,
    result: finalR > 0 ? "WIN" as const : "LOSS" as const,
    finalR,
    pnl,
    mfe: Math.max(finalR, 0),
    mae: Math.max(-finalR, 0),
    candlesHeld: 1,
    exitReason: "fixture",
    reason: "fixture",
    score: 80,
    confidence: "STRONG" as const,
    warnings: [],
    noFutureValidation: { signalId: id, confirmedAtIndex: 1, maxDataIndexUsedForSignal: 1, passedNoFutureCheck: true },
  };
}

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  const timestamp = Date.UTC(2026, 4, 20, 0, index * 5);
  return { time: new Date(timestamp).toISOString(), timestamp, open, high, low, close, volume: 100, closeTime: timestamp + 299_999, isClosed: true };
}
