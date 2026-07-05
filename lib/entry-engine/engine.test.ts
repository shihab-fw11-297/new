import { beforeEach, describe, expect, it } from "vitest";

import type { Candle } from "../candles/types";
import type { KeyLevel, MarketContextResult } from "../market-context/types";
import type { MarketStructureResult, MomentumMarker, StructureMarker, SweepMarker } from "../market-structure/types";
import type { MarketSetup, SetupScannerResult } from "../setup-scanner/types";
import {
  calculateRiskReward,
  calculateStopLoss,
  calculateTakeProfit,
  clearEntryEngineCache,
  generateHistoricalSignals,
  generateTradeSignals,
  getDefaultEntryEngineSettings,
} from "./engine";
import type { EntryEngineInput, EntryMode } from "./types";

describe("confirmed entry generation", () => {
  beforeEach(clearEntryEngineCache);

  it("creates a confirmed BUY from a valid bullish TRIGGER", () => {
    const signal = resultFor("BULLISH").signals[0];
    expect(signal.type).toBe("CONFIRMED_BUY");
    expect(signal.entryPrice).toBeGreaterThan(signal.stopLoss);
    expect(signal.takeProfit).toBeGreaterThan(signal.entryPrice);
    expect(signal.rr).toBeGreaterThanOrEqual(1.5);
  });

  it("creates a confirmed SELL from a valid bearish TRIGGER", () => {
    const signal = resultFor("BEARISH").signals[0];
    expect(signal.type).toBe("CONFIRMED_SELL");
    expect(signal.stopLoss).toBeGreaterThan(signal.entryPrice);
    expect(signal.takeProfit).toBeLessThan(signal.entryPrice);
    expect(signal.rr).toBeGreaterThanOrEqual(1.5);
  });

  it.each(["BULLISH", "BEARISH"] as const)("rejects a %s entry when nearest liquidity gives low RR", (direction) => {
    const input = fixture(direction);
    input.context.levels = [level(direction === "BULLISH" ? 104 : 96, direction === "BULLISH" ? "BSL" : "SSL")];
    input.setupScanner.setups[0].targetLiquidity!.price = direction === "BULLISH" ? 104 : 96;
    const result = generateTradeSignals(input);
    expect(result.signals).toHaveLength(0);
    expect(result.noTrade?.rejectionReasons.some((reason) => reason.includes("RR is"))).toBe(true);
  });

  it("rejects BUY when HTF is strongly bearish in PRO mode", () => {
    const input = fixture("BULLISH", "PRO_TRADER");
    input.context.htfBias.bias = "BEARISH";
    input.context.htfBias.strength = 90;
    expect(generateTradeSignals(input).noTrade?.rejectionReasons).toContain("HTF strongly opposes this direction.");
  });

  it("rejects SELL when HTF is strongly bullish in PRO mode", () => {
    const input = fixture("BEARISH", "PRO_TRADER");
    input.context.htfBias.bias = "BULLISH";
    input.context.htfBias.strength = 90;
    expect(generateTradeSignals(input).noTrade?.rejectionReasons).toContain("HTF strongly opposes this direction.");
  });

  it("rejects HIGH reversal risk", () => {
    const input = fixture("BULLISH");
    input.setupScanner.setups[0].antiReversal = { reversalRisk: "HIGH", warnings: ["high reversal"], shouldAvoid: true };
    expect(generateTradeSignals(input).noTrade?.rejectionReasons).toContain("Reversal risk is HIGH.");
  });

  it("uses structural stops on the correct side of BUY and SELL entries", () => {
    for (const direction of ["BULLISH", "BEARISH"] as const) {
      const input = fixture(direction);
      const stop = calculateStopLoss(input.setupScanner.setups[0], input.candles, 3, input.candles[3].close, 1);
      expect(stop).not.toBeNull();
      expect(direction === "BULLISH" ? stop!.price < input.candles[3].close : stop!.price > input.candles[3].close).toBe(true);
    }
  });

  it("uses liquidity targets on the correct side of BUY and SELL entries", () => {
    for (const direction of ["BULLISH", "BEARISH"] as const) {
      const input = fixture(direction);
      const target = calculateTakeProfit(input, input.setupScanner.setups[0], input.candles[3].close, 2.8, 1.5);
      expect(target).not.toBeNull();
      expect(direction === "BULLISH" ? target!.tp1 > input.candles[3].close : target!.tp1 < input.candles[3].close).toBe(true);
    }
  });

  it("ignores target levels first touched after the confirmation candle", () => {
    const input = fixture("BULLISH");
    const setup = input.setupScanner.setups[0];
    setup.targetLiquidity = null;
    input.context.levels = [
      {
        ...level(108, "BSL"),
        lastTouchedAt: input.candles[3].timestamp + 1,
      },
    ];

    expect(
      calculateTakeProfit(input, setup, input.candles[3].close, 2, 1.5, input.candles[3].timestamp),
    ).toBeNull();
  });

  it("calculates positive BUY and SELL risk/reward", () => {
    expect(calculateRiskReward("BULLISH", 100, 98, 104)).toEqual({ risk: 2, reward: 4, rr: 2 });
    expect(calculateRiskReward("BEARISH", 100, 102, 96)).toEqual({ risk: 2, reward: 4, rr: 2 });
  });

  it("enforces score thresholds per mode", () => {
    const calibration = fixture("BULLISH", "CALIBRATION", 44);
    const easy = fixture("BULLISH", "EASY_SCALP", 54);
    const normal = fixture("BULLISH", "NORMAL_SCALP", 66);
    const pro = fixture("BULLISH", "PRO_TRADER", 74);
    expect(generateTradeSignals(calibration).signals).toHaveLength(0);
    expect(generateTradeSignals(easy).signals).toHaveLength(0);
    expect(generateTradeSignals(normal).signals).toHaveLength(1);
    expect(generateTradeSignals(normal).signals[0].score).toBeGreaterThanOrEqual(65);
    expect(generateTradeSignals(pro).signals).toHaveLength(0);
  });

  it("allows the closed trigger candle itself to confirm when it is strong", () => {
    const signal = generateTradeSignals(fixture("BULLISH", "NORMAL_SCALP", 66)).signals[0];
    expect(signal.confirmedAtIndex).toBe(3);
    expect(signal.reasons.join(" ")).toContain("trigger candle confirmed immediately");
  });

  it("marks a live trigger as PENDING_CONFIRMATION instead of permanently rejecting it", () => {
    const input = weakTriggerFixture();
    const result = generateTradeSignals(input);
    expect(result.signals).toHaveLength(0);
    expect(result.rejectedSetups).toHaveLength(0);
    expect(result.pendingCandidates).toHaveLength(1);
    expect(result.pendingCandidates[0]).toMatchObject({
      setupScore: 66,
      requiredSetupScore: 55,
      requiredSignalScore: 60,
      confirmationStatus: "PENDING_CONFIRMATION",
      confirmationWindowRemaining: 2,
      nextRequiredAction: "Waiting for confirmation candle. 2 candles remaining.",
    });
  });

  it("confirms a pending setup when confirmation appears within three closed candles", () => {
    const input = weakTriggerFixture([
      candle(4, 101.05, 102.6, 100.95, 102.4),
    ]);
    const result = generateTradeSignals(input);
    expect(result.pendingCandidates).toHaveLength(0);
    expect(result.rejectedSetups).toHaveLength(0);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].confirmedAtIndex).toBe(4);
  });

  it("marks EXPIRED_CONFIRMATION when the three-candle window passes without confirmation", () => {
    const input = weakTriggerFixture([
      candle(4, 101.05, 101.2, 100.95, 101),
      candle(5, 101, 101.15, 100.9, 100.98),
      candle(6, 100.98, 101.1, 100.85, 100.96),
    ]);
    const result = generateTradeSignals(input);
    expect(result.signals).toHaveLength(0);
    expect(result.pendingCandidates).toHaveLength(0);
    expect(result.rejectedSetups[0].debug).toMatchObject({
      confirmationStatus: "EXPIRED_CONFIRMATION",
      confirmationWindowRemaining: 0,
      rejectionReason: "Rejected because confirmation window expired.",
    });
  });

  it("marks INVALIDATED when price closes beyond invalidation before confirmation", () => {
    const input = weakTriggerFixture([
      candle(4, 101.05, 101.2, 99.2, 99.4),
    ]);
    const result = generateTradeSignals(input);
    expect(result.signals).toHaveLength(0);
    expect(result.pendingCandidates).toHaveLength(0);
    expect(result.rejectedSetups[0].debug).toMatchObject({
      confirmationStatus: "INVALIDATED",
      rejectionReason: "Invalidated before confirmation.",
    });
  });

  it("creates NORMAL when final Phase 5 score meets the medium threshold", () => {
    const input = weakTriggerFixture([
      candle(4, 101.05, 101.5, 101, 101.45),
    ]);
    input.setupScanner.setups[0].score = 55;
    input.context.htfBias.bias = "BEARISH";
    input.context.htfBias.strength = 60;
    input.context.score.directionPreference = "BEARISH";
    input.context.regime.regime = "CHOPPY";
    input.context.regime.chopRisk = 90;
    input.context.volatility.state = "EXTREME_VOLATILITY";
    input.context.session.sessionQuality = 0;
    input.setupScanner.setups[0].antiReversal = { reversalRisk: "MEDIUM", warnings: ["medium reversal"], shouldAvoid: false };
    const result = generateTradeSignals(input);
    expect(result.rejectedSetups).toHaveLength(0);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].score).toBeGreaterThanOrEqual(60);
  });

  it("creates synthetic bullish sweep reversal signals in CALIBRATION and EASY", () => {
    const calibration = fixture("BULLISH", "CALIBRATION", 50);
    const easy = fixture("BULLISH", "EASY_SCALP", 74);
    expect(generateTradeSignals(calibration).signals).toHaveLength(1);
    expect(generateTradeSignals(easy).signals).toHaveLength(1);
    expect(generateTradeSignals(calibration).signals[0].type).toBe("CONFIRMED_BUY");
    expect(generateTradeSignals(easy).signals[0].type).toBe("CONFIRMED_BUY");
  });

  it("creates synthetic bearish sweep reversal signals in CALIBRATION and EASY", () => {
    expect(generateTradeSignals(fixture("BEARISH", "CALIBRATION", 50)).signals[0].type).toBe("CONFIRMED_SELL");
    expect(generateTradeSignals(fixture("BEARISH", "EASY_SCALP", 74)).signals[0].type).toBe("CONFIRMED_SELL");
  });

  it("returns NO_TRADE with exact rejection and requirements", () => {
    const input = fixture("BULLISH");
    input.setupScanner.setups[0].state = "SETUP";
    input.setupScanner.setups[0].history = [];
    input.setupScanner.audit.triggerCount = 0;
    const result = generateTradeSignals(input);
    expect(result.noTrade).toMatchObject({ status: "NO_TRADE", checkedSetups: 1 });
    expect(result.noTrade?.rejectionReasons[0]).toContain("not TRIGGER");
    expect(result.noTrade?.requiredForSignal.length).toBeGreaterThan(0);
  });

  it("does not appear before confirmedAtIndex and appears at replay timing", () => {
    const fullInput = fixture("BULLISH");
    const partial = { ...fullInput, candles: fullInput.candles.slice(0, 3) };
    expect(generateTradeSignals(partial).signals).toHaveLength(0);
    const signal = generateTradeSignals(fullInput).signals[0];
    expect(signal.confirmedAtIndex).toBe(3);
    expect(signal.timestamp).toBe(fullInput.candles[3].timestamp);
    expect(signal.noRepaintProof.status).toBe("PASS");
  });

  it("keeps original entry, SL, TP, RR, and score fixed after confirmation", () => {
    const input = fixture("BULLISH");
    const original = generateTradeSignals(input).signals[0];
    const laterCandle = candle(4, 102.2, 103, 102, 102.8);
    const later = generateTradeSignals({ ...input, candles: [...input.candles, laterCandle] }).signals[0];
    expect(later).toMatchObject({
      confirmedAtIndex: original.confirmedAtIndex,
      entryPrice: original.entryPrice,
      stopLoss: original.stopLoss,
      takeProfit: original.takeProfit,
      rr: original.rr,
      score: original.score,
    });
    expect(later.status).toBe("ACTIVE");
  });

  it("uses ATR at confirmation instead of a later candle ATR", () => {
    const input = historicalFixture("CALIBRATION");
    const original = generateHistoricalSignals(input).signals[0];
    const laterCandle = candle(8, 104.5, 104.51, 104.49, 104.5);
    const later = generateHistoricalSignals({
      ...input,
      candles: [...input.candles, laterCandle],
      structure: {
        ...input.structure,
        atr: [...input.structure.atr, 0.01],
      },
    }).signals[0];

    expect(later).toMatchObject({
      entryPrice: original.entryPrice,
      stopLoss: original.stopLoss,
      takeProfit: original.takeProfit,
      rr: original.rr,
    });
  });

  it("emits rare RAPID signals only with strong sweep, displacement, MSS, target, and session", () => {
    const input = fixture("BULLISH", "NORMAL_SCALP", 92);
    input.setupScanner.setups[0].relatedSweep!.strength = 3;
    input.setupScanner.setups[0].relatedStructure!.type = "MSS";
    expect(generateTradeSignals(input).signals[0].type).toBe("RAPID_BUY");
    expect(generateTradeSignals(input).signals[0].warnings).toContain("Rapid signal is aggressive and requires smaller risk.");
  });

  it("memoizes identical requests", () => {
    const input = fixture("BULLISH");
    expect(generateTradeSignals(input).audit.cacheStatus).toBe("miss");
    expect(generateTradeSignals(input).audit.cacheStatus).toBe("hit");
  });

  it("generates multiple historical signals instead of only the latest signal", () => {
    const input = historicalFixture();
    const result = generateHistoricalSignals(input);
    expect(result.signals).toHaveLength(2);
    expect(result.signals.map((signal) => signal.sourceSetupId)).toEqual(["setup-first", "setup-second"]);
    expect(result.signals.map((signal) => signal.confirmedAtIndex)).toEqual([3, 7]);
  });

  it("validates required signal object fields for history rows and chart markers", () => {
    const signal = generateHistoricalSignals(historicalFixture()).signals[0];
    expect(signal.id).toContain("XAUUSD:5m:NORMAL_SCALP");
    expect(signal.timestamp).toBeGreaterThan(0);
    expect(signal.candleIndex).toBe(signal.confirmedAtIndex);
    expect(Number.isFinite(signal.entryPrice)).toBe(true);
    expect(Number.isFinite(signal.stopLoss)).toBe(true);
    expect(Number.isFinite(signal.takeProfit)).toBe(true);
    expect(signal.rr).toBeGreaterThan(0);
    expect(signal.score).toBeGreaterThan(0);
    expect(signal.reasons.length).toBeGreaterThan(0);
    expect(signal.sourceSetupId).toBe("setup-first");
    expect(signal.mode).toBe("NORMAL_SCALP");
  });

  it("prevents duplicate historical signals with the stable signal ID map", () => {
    const input = historicalFixture();
    input.setupScanner.setups.push({ ...input.setupScanner.setups[0] });
    input.setupScanner.audit.triggerCount += 1;
    const result = generateHistoricalSignals(input);
    expect(result.signals).toHaveLength(2);
    expect(result.signalMap.size).toBe(2);
  });

  it("keeps EASY mode at least as permissive as NORMAL and NORMAL at least as permissive as PRO", () => {
    const calibration = generateHistoricalSignals({ ...historicalFixture("CALIBRATION"), mode: "CALIBRATION" }).signals.length;
    const easy = generateHistoricalSignals({ ...historicalFixture("EASY_SCALP"), mode: "EASY_SCALP" }).signals.length;
    const normal = generateHistoricalSignals({ ...historicalFixture("NORMAL_SCALP"), mode: "NORMAL_SCALP" }).signals.length;
    const pro = generateHistoricalSignals({ ...historicalFixture("PRO_TRADER"), mode: "PRO_TRADER" }).signals.length;
    expect(calibration).toBeGreaterThanOrEqual(easy);
    expect(easy).toBeGreaterThanOrEqual(normal);
    expect(normal).toBeGreaterThanOrEqual(pro);
  });

  it("records rejected setups, top rejection reasons, and no-trade message when no signal qualifies", () => {
    const input = historicalFixture("PRO_TRADER");
    input.context.htfBias.bias = "BEARISH";
    input.context.htfBias.strength = 95;
    const result = generateHistoricalSignals(input);
    expect(result.signals).toHaveLength(0);
    expect(result.rejectedSetups.length).toBeGreaterThan(0);
    expect(result.audit.topRejectionReasons.length).toBeGreaterThan(0);
    expect(result.noTrade?.message).toContain("No confirmed signal");
  });

  it("adds explicit no-repaint proof fields for historical signals", () => {
    const signal = generateHistoricalSignals(historicalFixture()).signals[0];
    expect(signal.noRepaintProof).toMatchObject({
      signalIndex: signal.confirmedAtIndex,
      latestAllowedCandleIndex: signal.confirmedAtIndex,
      usedSetupId: signal.sourceSetupId,
      passed: true,
      status: "PASS",
    });
    expect(Math.max(...signal.noRepaintProof.usedMarkerIndexes)).toBeLessThanOrEqual(signal.confirmedAtIndex);
  });
});

describe("mode configuration behavior", () => {
  beforeEach(clearEntryEngineCache);

  it("CALIBRATION has the lowest thresholds", () => {
    const calibration = fixture("BULLISH", "CALIBRATION", 40);
    const result = generateTradeSignals(calibration);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].score).toBeLessThan(60);
  });

  it("mode thresholds follow progression: CALIBRATION <= EASY <= NORMAL <= PRO in signal count", () => {
    const calibrationSignals = generateTradeSignals(fixture("BULLISH", "CALIBRATION", 55)).signals.length;
    const easySignals = generateTradeSignals(fixture("BULLISH", "EASY_SCALP", 55)).signals.length;
    const normalSignals = generateTradeSignals(fixture("BULLISH", "NORMAL_SCALP", 55)).signals.length;
    const proSignals = generateTradeSignals(fixture("BULLISH", "PRO_TRADER", 55)).signals.length;

    expect(calibrationSignals).toBeGreaterThanOrEqual(easySignals);
    expect(easySignals).toBeGreaterThanOrEqual(normalSignals);
    expect(normalSignals).toBeGreaterThanOrEqual(proSignals);
  });

  it("NORMAL requires minRR of 1.5 and PRO requires minRR of 2.0", () => {
    const normalSignal = generateTradeSignals(fixture("BULLISH", "NORMAL_SCALP", 92)).signals[0];
    expect(normalSignal.rr).toBeGreaterThanOrEqual(1.5);

    const proSignal = generateTradeSignals(fixture("BULLISH", "PRO_TRADER", 92)).signals[0];
    expect(proSignal.rr).toBeGreaterThanOrEqual(2.0);
  });

  it("PRO_TRADER rejects neutral HTF bias", () => {
    const input = fixture("BULLISH", "PRO_TRADER", 92);
    input.context.htfBias.bias = "NEUTRAL";
    const result = generateTradeSignals(input);
    expect(result.signals).toHaveLength(0);
    expect(result.noTrade?.rejectionReasons.some((r) => r.includes("HTF"))).toBe(true);
  });

  it("NORMAL_SCALP allows neutral HTF", () => {
    const input = fixture("BULLISH", "NORMAL_SCALP", 92);
    input.context.htfBias.bias = "NEUTRAL";
    input.context.htfBias.strength = 50;
    const result = generateTradeSignals(input);
    expect(result.signals).toHaveLength(1);
  });

  it("NORMAL_SCALP rejects opposite HTF", () => {
    const input = fixture("BULLISH", "NORMAL_SCALP", 92);
    input.context.htfBias.bias = "BEARISH";
    input.context.htfBias.strength = 75;
    const result = generateTradeSignals(input);
    expect(result.signals).toHaveLength(0);
  });

  it("confirmation window respected: CALIBRATION 4, EASY 3, NORMAL 3, PRO 2", () => {
    const input = weakTriggerFixture([
      candle(4, 101.05, 101.2, 100.95, 101),
      candle(5, 101, 101.15, 100.9, 100.98),
      candle(6, 100.98, 101.1, 100.85, 100.96),
      candle(7, 100.96, 101.05, 100.85, 100.95),
    ]);

    const result = generateTradeSignals(input);
    expect(result.signals).toHaveLength(0);
    const rejectedSetup = result.rejectedSetups[0];
    expect(rejectedSetup?.debug?.confirmationStatus).toBe("EXPIRED_CONFIRMATION");
  });

  it("PENDING_CONFIRMATION shows in candidate debug with remaining window", () => {
    const input = weakTriggerFixture();
    const result = generateTradeSignals(input);
    expect(result.pendingCandidates).toHaveLength(1);
    expect(result.pendingCandidates[0].confirmationStatus).toBe("PENDING_CONFIRMATION");
    expect(result.pendingCandidates[0].confirmationWindowRemaining).toBeGreaterThan(0);
  });

  it("CALIBRATION mode allows high reversal risk and extreme volatility", () => {
    const input = fixture("BULLISH", "CALIBRATION", 40);
    input.context.volatility.state = "EXTREME_VOLATILITY";
    input.setupScanner.setups[0].antiReversal = { reversalRisk: "HIGH", warnings: ["high"], shouldAvoid: true };
    const result = generateTradeSignals(input);
    expect(result.signals).toHaveLength(1);
  });
});

function resultFor(direction: "BULLISH" | "BEARISH") {
  return generateTradeSignals(fixture(direction));
}

function historicalFixture(mode: EntryMode = "NORMAL_SCALP"): EntryEngineInput {
  const candles = [
    candle(0, 100, 101, 99.5, 100.5),
    candle(1, 100.5, 101.2, 100, 100.8),
    candle(2, 100.8, 101.4, 100.4, 101),
    candle(3, 101, 102.5, 100.9, 102.2),
    candle(4, 102.2, 103, 101.8, 102.7),
    candle(5, 102.7, 103.2, 102.2, 102.9),
    candle(6, 102.9, 103.6, 102.5, 103.1),
    candle(7, 103.1, 104.8, 103, 104.5),
  ];
  const first = setupAt("setup-first", candles, 3, 99.5, 112);
  const second = setupAt("setup-second", candles, 7, 102.2, 116);
  const context = contextFixture("BULLISH");
  context.levels = [level(112, "BSL"), level(116, "BSL"), level(120, "BSL")];
  const markers = [
    first.relatedSweep!,
    first.relatedDisplacement!,
    first.relatedStructure!,
    second.relatedSweep!,
    second.relatedDisplacement!,
    second.relatedStructure!,
  ];
  return {
    candles,
    symbol: "XAUUSD",
    timeframe: "5m",
    startDate: "2026-05-20T00:00",
    endDate: "2026-05-21T00:00",
    mode,
    setupScanner: scannerFixtureList([first, second], candles.length - 1),
    context,
    structure: structureFixture(candles, markers),
    candleReading: null,
    settings: getDefaultEntryEngineSettings(),
  };
}

function setupAt(id: string, candles: Candle[], triggerIndex: number, invalidationPrice: number, targetPrice: number): MarketSetup {
  const setup = setupFixture("BULLISH", candles, 92);
  setup.id = id;
  setup.createdAt = candles[Math.max(0, triggerIndex - 3)].timestamp;
  setup.updatedAt = candles[triggerIndex].timestamp;
  setup.createdAtIndex = Math.max(0, triggerIndex - 3);
  setup.updatedAtIndex = triggerIndex;
  setup.relatedLtfCandles = [Math.max(0, triggerIndex - 3), Math.max(0, triggerIndex - 2), Math.max(0, triggerIndex - 1), triggerIndex];
  setup.relatedSweep!.id = `${id}-sweep`;
  setup.relatedSweep!.confirmedAtIndex = Math.max(0, triggerIndex - 2);
  setup.relatedSweep!.timestamp = candles[Math.max(0, triggerIndex - 2)].timestamp;
  setup.relatedSweep!.sweepPrice = invalidationPrice;
  setup.relatedDisplacement!.id = `${id}-displacement`;
  setup.relatedDisplacement!.confirmedAtIndex = Math.max(0, triggerIndex - 1);
  setup.relatedDisplacement!.timestamp = candles[Math.max(0, triggerIndex - 1)].timestamp;
  setup.relatedStructure!.id = `${id}-structure`;
  setup.relatedStructure!.confirmedAtIndex = triggerIndex;
  setup.relatedStructure!.timestamp = candles[triggerIndex].timestamp;
  setup.setupZone = { ...setup.setupZone, minPrice: candles[triggerIndex].low - 0.15, maxPrice: candles[triggerIndex].close + 0.15, midpoint: (candles[triggerIndex].low + candles[triggerIndex].close) / 2 };
  setup.invalidationLevel = { ...setup.invalidationLevel, price: invalidationPrice };
  setup.targetLiquidity = { ...setup.targetLiquidity!, price: targetPrice };
  setup.history = [{ from: "SETUP", to: "TRIGGER", timestamp: candles[triggerIndex].timestamp, candleIndex: triggerIndex, reason: "historical trigger" }];
  return setup;
}

function fixture(direction: "BULLISH" | "BEARISH", mode: EntryMode = "NORMAL_SCALP", setupScore = 92): EntryEngineInput {
  const candles = directionalCandles(direction);
  const setup = setupFixture(direction, candles, setupScore);
  const context = contextFixture(direction);
  const markers = [setup.relatedSweep!, setup.relatedDisplacement!, setup.relatedStructure!];
  return {
    candles,
    symbol: "XAUUSD",
    timeframe: "5m",
    startDate: "2026-05-20T00:00",
    endDate: "2026-05-21T00:00",
    mode,
    setupScanner: scannerFixture(setup, candles.length - 1),
    context,
    structure: structureFixture(candles, markers),
    candleReading: null,
    settings: getDefaultEntryEngineSettings(),
  };
}

function weakTriggerFixture(extraCandles: Candle[] = []): EntryEngineInput {
  const input = fixture("BULLISH", "NORMAL_SCALP", 66);
  const weakTrigger = candle(3, 101, 102, 100.9, 101.05);
  const candles = [...input.candles.slice(0, 3), weakTrigger, ...extraCandles];
  const setup = input.setupScanner.setups[0];
  setup.updatedAt = weakTrigger.timestamp;
  setup.relatedStructure!.timestamp = weakTrigger.timestamp;
  setup.relatedStructure!.price = weakTrigger.close;
  setup.relatedStructure!.breakPrice = weakTrigger.close;
  setup.setupZone = {
    ...setup.setupZone,
    minPrice: 100.2,
    maxPrice: 101.1,
    midpoint: 100.65,
  };
  setup.targetLiquidity = { ...setup.targetLiquidity!, price: 108 };
  setup.history = [{ from: "SETUP", to: "TRIGGER", timestamp: weakTrigger.timestamp, candleIndex: 3, reason: "weak closed trigger" }];
  return {
    ...input,
    candles,
    setupScanner: scannerFixture(setup, candles.length - 1),
    structure: structureFixture(candles, [setup.relatedSweep!, setup.relatedDisplacement!, setup.relatedStructure!]),
  };
}

function directionalCandles(direction: "BULLISH" | "BEARISH"): Candle[] {
  const bullish = [
    candle(0, 100, 101, 99.5, 100.5),
    candle(1, 100.5, 101.2, 100, 100.8),
    candle(2, 100.8, 101.4, 100.4, 101),
    candle(3, 101, 102.5, 100.9, 102.2),
  ];
  if (direction === "BULLISH") return bullish;
  return bullish.map((item) => ({ ...item, open: 200 - item.open, high: 200 - item.low, low: 200 - item.high, close: 200 - item.close }));
}

function setupFixture(direction: "BULLISH" | "BEARISH", candles: Candle[], score: number): MarketSetup {
  const bullish = direction === "BULLISH";
  const sweep: SweepMarker = {
    id: "sweep", type: bullish ? "SSL_SWEEP" : "BSL_SWEEP", timestamp: candles[1].timestamp, price: candles[1].close,
    direction, strength: 2, reason: "closed sweep", confirmedAtIndex: 1, confirmedAtTimestamp: candles[1].timestamp,
    sourceIndexes: [0, 1], sweptLiquidityId: "liquidity", sweepIndex: 1, sweepPrice: bullish ? candles[0].low : candles[0].high,
    closePrice: candles[1].close, rejectionStrength: 0.8, atrDistance: 0.5, sweepKind: "WICK_SWEEP",
  };
  const displacement: MomentumMarker = {
    id: "displacement", type: "DISPLACEMENT", timestamp: candles[2].timestamp, price: candles[2].close, direction, strength: 3,
    reason: "directional displacement", confirmedAtIndex: 2, confirmedAtTimestamp: candles[2].timestamp, sourceIndexes: [2],
    index: 2, bodySize: 0.8, rangeSize: 1, atr: 1, closePosition: bullish ? 0.9 : 0.1,
  };
  const structure: StructureMarker = {
    id: "structure", type: "BOS", timestamp: candles[3].timestamp, price: candles[3].close, direction, strength: 3,
    reason: "confirmed structure shift", confirmedAtIndex: 3, confirmedAtTimestamp: candles[3].timestamp, sourceIndexes: [2, 3],
    breakIndex: 3, breakPrice: candles[3].close, brokenSwingId: "swing", previousStructure: "RANGING", newStructure: direction,
    confirmed: true,
  };
  const zone = bullish ? { minPrice: 100.2, maxPrice: 101.1 } : { minPrice: 98.9, maxPrice: 99.8 };
  return {
    id: `setup-${direction}`, type: "LIQUIDITY_SWEEP_REVERSAL", direction, state: "TRIGGER", createdAt: candles[0].timestamp,
    updatedAt: candles[3].timestamp, createdAtIndex: 0, updatedAtIndex: 3, sourceTimeframe: "5m", relatedHtfContext: `${direction} 90/100`,
    relatedItfContext: `READY_FOR_LTF_TRIGGER 90/100`, relatedLtfCandles: [0, 1, 2, 3], relatedLiquidity: null, relatedSweep: sweep,
    relatedDisplacement: displacement, relatedStructure: structure, relatedFvg: null,
    setupZone: { type: "SWEPT_LIQUIDITY_RETEST", ...zone, midpoint: (zone.minPrice + zone.maxPrice) / 2, createdFrom: "fixture", strength: 90, reason: "retest" },
    invalidationLevel: { price: bullish ? 99.5 : 100.5, source: "SWEEP_EXTREME", reason: "sweep fails" },
    targetLiquidity: { targetType: bullish ? "BSL" : "SSL", price: bullish ? 108 : 92, distance: 6, strength: 3, reason: "unswept liquidity" },
    score, scoreBreakdown: { htfContext: 15, itfQuality: 15, liquidityQuality: 12, sweepDisplacement: 15, structureQuality: 15, premiumDiscount: 8, sessionQuality: 5, volatilityQuality: 5, candlePsychology: 5 },
    reasons: ["Phase 4 trigger is confirmed."], warnings: [], failedReasons: [], antiReversal: { reversalRisk: "LOW", warnings: [], shouldAvoid: false },
    history: [{ from: "SETUP", to: "TRIGGER", timestamp: candles[3].timestamp, candleIndex: 3, reason: "closed trigger" }],
  };
}

function contextFixture(direction: "BULLISH" | "BEARISH"): MarketContextResult {
  const bullish = direction === "BULLISH";
  const prices = bullish ? [108, 112] : [88, 92];
  return {
    mapping: { ltf: "5m", itf: "15m", htf: "1h", modeName: "5M SCALPING" }, itfCandles: [], htfCandles: [],
    htfBias: { bias: direction, strength: 90, structureState: direction, lastBos: null, lastChoch: null, majorSwingHigh: 112, majorSwingLow: 88, reason: "aligned", warnings: [] },
    itfSetup: { setupState: "READY_FOR_LTF_TRIGGER", direction, strength: 90, relatedLiquidity: null, relatedSweep: null, relatedDisplacement: null, relatedStructure: null, pullbackZone: null, reason: "ready", invalidation: null },
    premiumDiscount: { rangeHigh: 112, rangeLow: 88, equilibrium: 100, currentPositionPercent: bullish ? 35 : 65, zone: bullish ? "DISCOUNT" : "PREMIUM", buyQuality: 90, sellQuality: 90, reason: "location" },
    levels: prices.map((price) => level(price, bullish ? "BSL" : "SSL")),
    nearestLevels: { nearestResistance: null, nearestSupport: null, nearestBSL: null, nearestSSL: null, distanceToResistance: 6, distanceToSupport: 6 },
    regime: { regime: bullish ? "TRENDING_BULLISH" : "TRENDING_BEARISH", confidence: 90, trendQuality: 90, rangeQuality: 10, volatilityQuality: 80, chopRisk: 10, reason: "clean trend", warnings: [] },
    session: { session: "LONDON_NEW_YORK_OVERLAP", displayTimezone: "UTC", sessionQuality: 90, sessionOpen: null, sessionClose: null, currentSessionHigh: null, currentSessionLow: null, previousSessionHigh: null, previousSessionLow: null, sessionBias: direction, reason: "active" },
    volatility: { state: "NORMAL_VOLATILITY", atr: 1, atrPercentile: 50, averageRange: 1, expansionRatio: 1, warning: null, reason: "normal" },
    score: { overallScore: 90, directionPreference: direction, tradeEnvironment: "GOOD", reason: "aligned", warnings: [] },
    wait: { shouldWait: false, waitReasons: [], requiredForImprovement: [] }, cacheStatus: "miss",
  };
}

function scannerFixture(setup: MarketSetup, currentIndex: number): SetupScannerResult {
  return scannerFixtureList([setup], currentIndex);
}

function scannerFixtureList(setups: MarketSetup[], currentIndex: number): SetupScannerResult {
  return {
    setups,
    activeSetups: setups,
    invalidatedSetups: [],
    expiredSetups: [],
    setupMap: new Map(setups.map((setup) => [setup.id, setup])),
    audit: { processedCandles: currentIndex + 1, currentCandleIndex: currentIndex, activeSetupCount: setups.length, watchCount: 0, setupCount: 0, triggerCount: setups.length, invalidatedCount: 0, expiredCount: 0, transitionCount: setups.length, calculationTimeMs: 1, cacheStatus: "miss", noFutureValidation: "pass" },
  };
}

function structureFixture(candles: Candle[], markers: Array<SweepMarker | MomentumMarker | StructureMarker>): MarketStructureResult {
  return {
    candles, markers, markerMap: new Map(markers.map((marker) => [marker.id, marker])), liquidityZones: [], liquidityZoneMap: new Map(), fvgZones: [],
    atr: candles.map(() => 1), audit: { totalCandles: candles.length, totalSwingHighs: 0, totalSwingLows: 0, totalBslZones: 0, totalSslZones: 0, totalEqualHighZones: 0, totalEqualLowZones: 0, totalSweeps: 1, totalSslSweeps: 0, totalBslSweeps: 0, totalMomentumCandles: 1, totalBullishMomentum: 0, totalBearishMomentum: 0, totalBuyersMarkers: 0, totalSellersMarkers: 0, totalBos: 1, totalChoch: 0, totalMss: 0, totalFvg: 0, totalMitigatedFvg: 0, calculationTimeMs: 1, lastMarkerCreated: null, currentStructureState: "RANGING", markerSensitivitySettings: { sensitivity: "normal", leftBars: 2, rightBars: 2, atrPeriod: 14, showOnlyMajor: false }, cacheStatus: "miss", validationWarnings: [], noRepaintValidationStatus: "pass" },
  };
}

function level(price: number, type: KeyLevel["type"]): KeyLevel {
  return { id: `${type}-${price}`, type, timeframe: "HTF", price, minPrice: price, maxPrice: price, strength: 3, touchedCount: 0, lastTouchedAt: 0, swept: false, distanceFromCurrentPrice: 1, reason: "target" };
}

function candle(index: number, open: number, high: number, low: number, close: number): Candle {
  const timestamp = Date.UTC(2026, 4, 20, 0, index * 5);
  return { time: new Date(timestamp).toISOString(), timestamp, open, high, low, close, volume: 100, closeTime: timestamp + 299_999, isClosed: true };
}
