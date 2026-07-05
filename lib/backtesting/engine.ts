import type { Candle } from "../candles/types";
import type { RejectedSetup, TradeSignal } from "../entry-engine/types";
import type {
  BacktestInput,
  BacktestResult,
  BacktestSettings,
  BacktestTrade,
  BacktestTradeResult,
  BreakdownRow,
  CalibrationResult,
  CalibrationSettings,
  NoFutureValidation,
  PerformanceMetrics,
  PropFirmResult,
  PropFirmSettings,
  RejectionAnalytics,
  RobustnessResult,
} from "./types";

const DEFAULT_SETTINGS: BacktestSettings = {
  signalMode: "NORMAL_SCALP",
  accountBalance: 10_000,
  riskPerTradePercent: 0.5,
  maxTradesPerDay: 2,
  maxDailyLossPercent: 2,
  spreadPoints: 0,
  slippagePoints: 0,
  commissionPerLot: 0,
  sameCandlePolicy: "CONSERVATIVE_SL_FIRST",
  enableBreakeven: true,
  enablePartials: true,
  enableTrailing: false,
  sessionFilter: "ALL",
  setupTypeFilter: "ALL",
  maxHoldingCandles: 96,
};

const DEFAULT_PROP_RULES: PropFirmSettings = {
  startingBalance: 10_000,
  profitTargetPercent: 8,
  maxDailyLossPercent: 5,
  maxTotalDrawdownPercent: 10,
  maxTradesPerDay: 2,
  minTradingDays: 5,
  consistencyRulePercent: 40,
};

const resultCache = new Map<string, BacktestResult>();

export function getDefaultBacktestSettings(): BacktestSettings {
  return { ...DEFAULT_SETTINGS };
}

export function clearBacktestCache(): void {
  resultCache.clear();
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const started = performance.now();
  const settings = { ...DEFAULT_SETTINGS, ...input.settings };
  const candles = input.candles.filter((candle) => candle.isClosed);
  const cacheKey = buildCacheKey(input, settings, candles);
  const cached = resultCache.get(cacheKey);
  if (cached) return cloneResult(cached, "hit");

  const candleByTimestamp = new Map(candles.map((candle, index) => [candle.timestamp, { candle, index }]));
  const signals = input.signals
    .filter((signal) => settings.signalMode === "CALIBRATION" || signal.mode === settings.signalMode)
    .filter((signal) => settings.sessionFilter === "ALL" || signal.session === settings.sessionFilter)
    .filter((signal) => settings.setupTypeFilter === "ALL" || signal.setupType === settings.setupTypeFilter)
    .filter((signal) => signal.noRepaintProof.passed)
    .sort((a, b) => a.confirmedAtIndex - b.confirmedAtIndex);
  const signalByIndex = new Map<number, TradeSignal[]>();
  for (const signal of signals) {
    const bucket = signalByIndex.get(signal.confirmedAtIndex) ?? [];
    bucket.push(signal);
    signalByIndex.set(signal.confirmedAtIndex, bucket);
  }

  const trades: BacktestTrade[] = [];
  const dailyTradeCount = new Map<string, number>();
  const dailyPnl = new Map<string, number>();
  let balance = settings.accountBalance;

  for (let index = 0; index < candles.length; index += 1) {
    const signalsAtIndex = signalByIndex.get(index) ?? [];
    for (const signal of signalsAtIndex) {
      const day = dateKey(signal.timestamp);
      const tradesToday = dailyTradeCount.get(day) ?? 0;
      const lossToday = Math.min(0, dailyPnl.get(day) ?? 0);
      const maxDailyLossAmount = settings.accountBalance * settings.maxDailyLossPercent / 100;
      if (tradesToday >= settings.maxTradesPerDay || Math.abs(lossToday) >= maxDailyLossAmount) continue;
      const candlePosition = candleByTimestamp.get(signal.timestamp);
      const entryIndex = candlePosition?.index ?? signal.confirmedAtIndex;
      const trade = evaluateTrade({
        signal,
        candles,
        entryIndex,
        settings,
        startingBalance: balance,
        symbol: input.symbol,
        timeframe: input.timeframe,
      });
      trades.push(trade);
      balance += trade.pnl;
      dailyTradeCount.set(day, tradesToday + 1);
      dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + trade.pnl);
    }
  }

  const equityCurve = buildEquityCurve(trades, settings.accountBalance);
  const metrics = calculatePerformanceMetrics(trades, settings.accountBalance);
  const result: BacktestResult = {
    trades,
    tradeMap: new Map(trades.map((trade) => [trade.tradeId, trade])),
    equityCurve,
    metrics,
    breakdowns: {
      bySession: breakdown(trades, (trade) => trade.session),
      bySetupType: breakdown(trades, (trade) => trade.setupType),
      byDirection: breakdown(trades, (trade) => trade.direction === "BULLISH" ? "BUY" : "SELL"),
      byMarketRegime: breakdown(trades, () => input.marketRegime ?? "UNKNOWN"),
      byScoreBucket: breakdown(trades, (trade) => scoreBucket(trade.score)),
      byRrBucket: breakdown(trades, (trade) => rrBucket(trade.rr)),
      byHour: breakdown(trades, (trade) => `${new Date(trade.entryTime).getUTCHours().toString().padStart(2, "0")}:00 UTC`),
    },
    rejectionAnalytics: buildRejectionAnalytics(input.rejectedSetups, input.signals.length, trades.length, candles),
    calibration: runCalibration(input, settings, candles),
    robustness: runRobustness(trades),
    propFirm: simulatePropFirm(trades, { ...DEFAULT_PROP_RULES, startingBalance: settings.accountBalance, maxDailyLossPercent: settings.maxDailyLossPercent, maxTradesPerDay: settings.maxTradesPerDay }),
    exports: buildExports(input, trades, input.rejectedSetups),
    audit: {
      cacheStatus: "miss",
      calculationTimeMs: round(performance.now() - started, 2),
      signalCountInput: input.signals.length,
      signalCountTested: trades.length,
      noFutureFailures: input.signals.filter((signal) => !signal.noRepaintProof.passed).length,
      progressPercent: 100,
      cacheKey,
    },
  };

  if (resultCache.size >= 30) resultCache.delete(resultCache.keys().next().value ?? "");
  resultCache.set(cacheKey, result);
  return result;
}

function evaluateTrade(input: {
  signal: TradeSignal;
  candles: Candle[];
  entryIndex: number;
  settings: BacktestSettings;
  startingBalance: number;
  symbol: string;
  timeframe: BacktestInput["timeframe"];
}): BacktestTrade {
  const { signal, candles, entryIndex, settings } = input;
  const bullish = signal.direction === "BULLISH";
  const costPoints = settings.spreadPoints + settings.slippagePoints;
  const entryPrice = round(bullish ? signal.entryPrice + costPoints : signal.entryPrice - costPoints);
  const initialStop = signal.stopLoss;
  const riskPoints = bullish ? entryPrice - initialStop : initialStop - entryPrice;
  const riskAmount = input.startingBalance * settings.riskPerTradePercent / 100;
  const commissionImpact = settings.commissionPerLot;
  const noFutureValidation: NoFutureValidation = {
    signalId: signal.id,
    confirmedAtIndex: signal.confirmedAtIndex,
    maxDataIndexUsedForSignal: signal.noRepaintProof.maxEvidenceIndex,
    passedNoFutureCheck: signal.noRepaintProof.maxEvidenceIndex <= signal.confirmedAtIndex && signal.noRepaintProof.passed,
  };

  if (riskPoints <= 0 || entryIndex >= candles.length - 1) {
    return tradeFrom(signal, input, entryPrice, initialStop, "EXPIRED", 0, 0, 0, 0, entryIndex, null, "Invalid risk or no future candle available.", noFutureValidation);
  }

  const targets = [signal.takeProfit, signal.takeProfit2, signal.takeProfit3].filter((value): value is number => value !== null);
  const targetFractions = settings.enablePartials && targets.length > 1 ? [0.5, 0.3, 0.2] : [1];
  let remaining = 1;
  let realizedR = 0;
  let stopPrice = initialStop;
  let nextTarget = 0;
  let mfe = 0;
  let mae = 0;
  let exitIndex: number | null = null;
  let exitReason = "Time stop reached before TP or SL.";
  let result: BacktestTradeResult = "TIME_EXIT";
  const maxIndex = Math.min(candles.length - 1, entryIndex + settings.maxHoldingCandles);

  for (let index = entryIndex + 1; index <= maxIndex; index += 1) {
    const candle = candles[index];
    const favorable = bullish ? candle.high - entryPrice : entryPrice - candle.low;
    const adverse = bullish ? entryPrice - candle.low : candle.high - entryPrice;
    mfe = Math.max(mfe, favorable / riskPoints);
    mae = Math.max(mae, adverse / riskPoints);
    if (settings.enableBreakeven && mfe >= 1) stopPrice = bullish ? Math.max(stopPrice, entryPrice) : Math.min(stopPrice, entryPrice);
    if (settings.enableTrailing && mfe >= 1.5) stopPrice = bullish ? Math.max(stopPrice, entryPrice + riskPoints * 0.5) : Math.min(stopPrice, entryPrice - riskPoints * 0.5);

    const stopHit = bullish ? candle.low <= stopPrice : candle.high >= stopPrice;
    const target = targets[Math.min(nextTarget, targets.length - 1)];
    const targetHit = target !== undefined && (bullish ? candle.high >= target : candle.low <= target);

    if (stopHit && targetHit) {
      if (settings.sameCandlePolicy === "MARK_UNKNOWN") {
        result = "UNKNOWN_INTRACANDLE";
        exitReason = "TP and SL were both touched in the same candle; policy marks result unknown.";
        exitIndex = index;
        break;
      }
      if (settings.sameCandlePolicy === "CONSERVATIVE_SL_FIRST") {
        const stopR = stopToR(bullish, entryPrice, stopPrice, riskPoints);
        realizedR += remaining * stopR;
        remaining = 0;
        result = classifyResult(realizedR, nextTarget > 0);
        exitReason = "TP and SL touched in the same candle; conservative policy applied SL first.";
        exitIndex = index;
        break;
      }
    }

    if (targetHit && target !== undefined) {
      const fraction = Math.min(remaining, targetFractions[Math.min(nextTarget, targetFractions.length - 1)] ?? remaining);
      realizedR += fraction * targetToR(bullish, entryPrice, target, riskPoints);
      remaining = round(Math.max(0, remaining - fraction), 6);
      nextTarget += 1;
      if (settings.enableBreakeven) stopPrice = bullish ? Math.max(stopPrice, entryPrice) : Math.min(stopPrice, entryPrice);
      if (remaining <= 0 || nextTarget >= targets.length) {
        result = nextTarget > 1 ? "PARTIAL_WIN" : "WIN";
        exitReason = nextTarget > 1 ? "Final partial target was reached." : "Primary take profit was reached.";
        exitIndex = index;
        break;
      }
    }

    if (stopHit) {
      const stopR = stopToR(bullish, entryPrice, stopPrice, riskPoints);
      realizedR += remaining * stopR;
      remaining = 0;
      result = classifyResult(realizedR, nextTarget > 0);
      exitReason = stopR === 0 ? "Breakeven stop was reached." : "Stop loss was reached.";
      exitIndex = index;
      break;
    }
  }

  if (exitIndex === null) {
    const last = candles[maxIndex];
    const closeR = bullish ? (last.close - entryPrice) / riskPoints : (entryPrice - last.close) / riskPoints;
    realizedR += remaining * closeR;
    result = maxIndex === candles.length - 1 ? "EXPIRED" : "TIME_EXIT";
    exitIndex = maxIndex;
  }

  const finalR = round(realizedR, 3);
  const pnl = round(finalR * riskAmount - commissionImpact, 2);
  return tradeFrom(signal, input, entryPrice, initialStop, result, finalR, pnl, round(mfe, 3), round(mae, 3), entryIndex, exitIndex, exitReason, noFutureValidation);
}

function tradeFrom(
  signal: TradeSignal,
  input: { candles: Candle[]; settings: BacktestSettings; symbol: string; timeframe: BacktestInput["timeframe"] },
  entryPrice: number,
  stopLoss: number,
  result: BacktestTradeResult,
  finalR: number,
  pnl: number,
  mfe: number,
  mae: number,
  entryIndex: number,
  exitIndex: number | null,
  exitReason: string,
  noFutureValidation: NoFutureValidation,
): BacktestTrade {
  return {
    tradeId: `bt:${signal.id}`,
    signalId: signal.id,
    direction: signal.direction,
    setupType: signal.setupType,
    session: signal.session,
    mode: input.settings.signalMode,
    symbol: input.symbol,
    timeframe: input.timeframe,
    entryTime: signal.timestamp,
    exitTime: exitIndex === null ? null : input.candles[exitIndex]?.timestamp ?? null,
    entryIndex,
    exitIndex,
    entryPrice,
    stopLoss,
    takeProfit: signal.takeProfit,
    takeProfit2: signal.takeProfit2,
    takeProfit3: signal.takeProfit3,
    rr: signal.rr,
    result,
    finalR,
    pnl,
    mfe,
    mae,
    candlesHeld: exitIndex === null ? 0 : Math.max(0, exitIndex - entryIndex),
    exitReason,
    reason: signal.reasons[0] ?? "Phase 5 confirmed signal.",
    score: signal.score,
    confidence: signal.confidence,
    warnings: signal.warnings,
    noFutureValidation,
  };
}

export function calculatePerformanceMetrics(trades: BacktestTrade[], startingBalance = DEFAULT_SETTINGS.accountBalance): PerformanceMetrics {
  const wins = trades.filter((trade) => trade.finalR > 0.05).length;
  const losses = trades.filter((trade) => trade.finalR < -0.05).length;
  const breakeven = trades.length - wins - losses;
  const winRate = trades.length ? wins / trades.length : 0;
  const lossRate = trades.length ? losses / trades.length : 0;
  const winRs = trades.filter((trade) => trade.finalR > 0).map((trade) => trade.finalR);
  const lossRs = trades.filter((trade) => trade.finalR < 0).map((trade) => Math.abs(trade.finalR));
  const averageWinR = mean(winRs);
  const averageLossR = mean(lossRs);
  const grossProfit = winRs.reduce((total, value) => total + value, 0);
  const grossLoss = lossRs.reduce((total, value) => total + value, 0);
  const totalR = trades.reduce((total, trade) => total + trade.finalR, 0);
  return {
    totalTrades: trades.length,
    wins,
    losses,
    breakeven,
    winRate: roundPercent(winRate),
    lossRate: roundPercent(lossRate),
    averageWinR: round(averageWinR, 3),
    averageLossR: round(averageLossR, 3),
    expectancy: round((winRate * averageWinR) - (lossRate * averageLossR), 3),
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : round(grossProfit / grossLoss, 3),
    totalR: round(totalR, 3),
    netPnl: round(trades.reduce((total, trade) => total + trade.pnl, 0), 2),
    maxDrawdown: calculateMaxDrawdown(trades, startingBalance),
    maxConsecutiveWins: maxStreak(trades, (trade) => trade.finalR > 0.05),
    maxConsecutiveLosses: maxStreak(trades, (trade) => trade.finalR < -0.05),
    averageRr: round(mean(trades.map((trade) => trade.rr)), 3),
    averageMfe: round(mean(trades.map((trade) => trade.mfe)), 3),
    averageMae: round(mean(trades.map((trade) => trade.mae)), 3),
    averageCandlesHeld: round(mean(trades.map((trade) => trade.candlesHeld)), 2),
    bestTrade: round(Math.max(0, ...trades.map((trade) => trade.finalR)), 3),
    worstTrade: round(Math.min(0, ...trades.map((trade) => trade.finalR)), 3),
    largestMissedMfe: round(Math.max(0, ...trades.map((trade) => trade.mfe - Math.max(0, trade.finalR))), 3),
    averageSlippageCommissionImpact: trades.length ? round(trades.reduce((total, trade) => total + Math.max(0, trade.finalR * DEFAULT_SETTINGS.accountBalance * DEFAULT_SETTINGS.riskPerTradePercent / 100 - trade.pnl), 0) / trades.length, 2) : 0,
  };
}

function buildEquityCurve(trades: BacktestTrade[], startingBalance: number): Array<{ timestamp: number; balance: number; drawdown: number }> {
  let balance = startingBalance;
  let peak = startingBalance;
  return trades.map((trade) => {
    balance += trade.pnl;
    peak = Math.max(peak, balance);
    return { timestamp: trade.exitTime ?? trade.entryTime, balance: round(balance, 2), drawdown: round(peak - balance, 2) };
  });
}

export function calculateMaxDrawdown(trades: BacktestTrade[], startingBalance = DEFAULT_SETTINGS.accountBalance): number {
  let balance = startingBalance;
  let peak = startingBalance;
  let maxDrawdown = 0;
  for (const trade of trades) {
    balance += trade.pnl;
    peak = Math.max(peak, balance);
    maxDrawdown = Math.max(maxDrawdown, peak - balance);
  }
  return round(maxDrawdown, 2);
}

function breakdown(trades: BacktestTrade[], keyFor: (trade: BacktestTrade) => string): BreakdownRow[] {
  const groups = new Map<string, BacktestTrade[]>();
  for (const trade of trades) {
    const key = keyFor(trade);
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const metrics = calculatePerformanceMetrics(group);
    return { key, totalTrades: group.length, winRate: metrics.winRate, profitFactor: metrics.profitFactor, expectancy: metrics.expectancy, totalR: metrics.totalR, netPnl: metrics.netPnl };
  }).sort((a, b) => b.totalTrades - a.totalTrades || a.key.localeCompare(b.key));
}

function buildRejectionAnalytics(rejectedSetups: RejectedSetup[], confirmedSignalCount: number, tradeCount: number, candles: Candle[]): RejectionAnalytics {
  const reasons = rejectedSetups.flatMap((setup) => setup.rejectionReasons.length ? setup.rejectionReasons : ["Unknown rejection"]);
  const histogram = countReasons(reasons);
  let wouldWin = 0;
  let avoidedLoss = 0;
  for (const setup of rejectedSetups) {
    const outcome = estimateRejectedOutcome(setup, candles);
    if (outcome === "WIN") wouldWin += 1;
    if (outcome === "LOSS") avoidedLoss += 1;
  }
  return {
    totalSetupsScanned: rejectedSetups.length + confirmedSignalCount,
    watchCount: rejectedSetups.filter((setup) => setup.setupState === "WATCH").length,
    setupCount: rejectedSetups.filter((setup) => setup.setupState === "SETUP").length,
    triggerCount: rejectedSetups.filter((setup) => setup.triggerIndex !== null).length,
    confirmedSignalCount: tradeCount,
    rejectedSignalCount: rejectedSetups.length,
    topRejectionReasons: histogram.slice(0, 10),
    rejectionHistogram: histogram,
    rejectedButLaterWouldHaveWonCount: wouldWin,
    rejectedAndCorrectlyAvoidedLossCount: avoidedLoss,
    notes: histogram.length
      ? [`${histogram[0].count} setups were rejected due to ${histogram[0].reason}. ${wouldWin} rejected setups later moved roughly 1R in their direction, so review whether that filter is too strict for this timeframe.`]
      : ["No rejected Phase 5 setups were available for calibration analysis."],
  };
}

function runCalibration(input: BacktestInput, settings: BacktestSettings, candles: Candle[]): CalibrationResult[] {
  const sets: CalibrationResult["settingName"][] = ["current settings", "relaxed settings", "strict settings", "custom settings"];
  return sets.map((name) => {
    const calibration = calibrationSettings(name);
    const filteredSignals = input.signals.filter((signal) =>
      signal.score >= calibration.minSignalScore &&
      signal.rr >= calibration.minRR &&
      (settings.signalMode === "CALIBRATION" || signal.mode === settings.signalMode) &&
      (calibration.sessionRequired ? signal.session !== "DEAD_ZONE" : true),
    );
    const trades = filteredSignals.map((signal) => evaluateTrade({
      signal,
      candles,
      entryIndex: signal.confirmedAtIndex,
      settings,
      startingBalance: settings.accountBalance,
      symbol: input.symbol,
      timeframe: input.timeframe,
    }));
    const metrics = calculatePerformanceMetrics(trades, settings.accountBalance);
    return {
      settingName: name,
      settings: calibration,
      totalTrades: metrics.totalTrades,
      winRate: metrics.winRate,
      profitFactor: metrics.profitFactor,
      expectancy: metrics.expectancy,
      maxDrawdown: metrics.maxDrawdown,
      totalR: metrics.totalR,
      notes: ["Best historical settings may overfit and fail live.", name === "relaxed settings" ? "Relaxed filters expose whether signal scarcity is filter-driven." : "Uses Phase 5 signals only; no new entry logic was created."],
    };
  });
}

function runRobustness(trades: BacktestTrade[]): RobustnessResult {
  const reversed = [...trades].reverse();
  const removeTop = [...trades].sort((a, b) => b.finalR - a.finalR).slice(2);
  const reducedWinRate = trades.map((trade, index) => index % 20 === 0 && trade.finalR > 0 ? { ...trade, finalR: -1, pnl: -Math.abs(trade.pnl) } : trade);
  const increasedSpread = trades.map((trade) => ({ ...trade, finalR: round(trade.finalR - 0.1, 3), pnl: round(trade.pnl - 5, 2) }));
  const worstDrawdown = Math.max(calculateMaxDrawdown(reversed), calculateMaxDrawdown(removeTop), calculateMaxDrawdown(reducedWinRate), calculateMaxDrawdown(increasedSpread));
  const losingStreak = maxStreak(trades, (trade) => trade.finalR < -0.05);
  return {
    worstCaseDrawdown: worstDrawdown,
    averageOutcome: round(mean([sumR(reversed), sumR(removeTop), sumR(reducedWinRate), sumR(increasedSpread)]), 3),
    probabilityOfLosingStreak: roundPercent(trades.length ? Math.min(1, losingStreak / Math.max(3, trades.length)) : 0),
    riskOfRuinWarning: worstDrawdown > DEFAULT_SETTINGS.accountBalance * 0.1 ? "Robustness scenarios exceed a 10% drawdown stress threshold." : null,
    removeTopWinnersTotalR: sumR(removeTop),
    increasedSpreadTotalR: sumR(increasedSpread),
    reducedWinRateTotalR: sumR(reducedWinRate),
  };
}

export function simulatePropFirm(trades: BacktestTrade[], settings: PropFirmSettings = DEFAULT_PROP_RULES): PropFirmResult {
  let balance = settings.startingBalance;
  let peak = settings.startingBalance;
  const dailyPnl = new Map<string, number>();
  for (const trade of trades) {
    balance += trade.pnl;
    peak = Math.max(peak, balance);
    dailyPnl.set(dateKey(trade.entryTime), (dailyPnl.get(dateKey(trade.entryTime)) ?? 0) + trade.pnl);
  }
  const targetBalance = settings.startingBalance * (1 + settings.profitTargetPercent / 100);
  const maxDailyLoss = settings.startingBalance * settings.maxDailyLossPercent / 100;
  const maxTotalDrawdown = settings.startingBalance * settings.maxTotalDrawdownPercent / 100;
  const bestDay = Math.max(0, ...dailyPnl.values());
  const profit = Math.max(0, balance - settings.startingBalance);
  const dailyDrawdownHit = [...dailyPnl.values()].some((value) => value < -maxDailyLoss);
  const totalDrawdownHit = peak - balance > maxTotalDrawdown;
  const profitTargetHit = balance >= targetBalance;
  const tradingDaysCount = dailyPnl.size;
  const concentration = profit > 0 ? roundPercent(bestDay / profit) : 0;
  const failReason = dailyDrawdownHit
    ? "Daily drawdown limit hit."
    : totalDrawdownHit
      ? "Total drawdown limit hit."
      : !profitTargetHit
        ? "Profit target not reached."
        : tradingDaysCount < settings.minTradingDays
          ? "Minimum trading days not reached."
          : concentration > settings.consistencyRulePercent
            ? "Best-day profit concentration violated consistency rule."
            : null;
  return {
    passed: failReason === null,
    failReason,
    dailyDrawdownHit,
    totalDrawdownHit,
    profitTargetHit,
    tradingDaysCount,
    bestDayProfitConcentration: concentration,
  };
}

function buildExports(input: BacktestInput, trades: BacktestTrade[], rejectedSetups: RejectedSetup[]) {
  const tradeHeader = "date,symbol,timeframe,mode,direction,setupType,session,entry,sl,tp,rr,result,finalR,pnl,mfe,mae,candlesHeld,reason";
  const tradeRows = trades.map((trade) => [
    new Date(trade.entryTime).toISOString(),
    trade.symbol,
    trade.timeframe,
    trade.mode,
    trade.direction,
    trade.setupType,
    trade.session,
    trade.entryPrice,
    trade.stopLoss,
    trade.takeProfit,
    trade.rr,
    trade.result,
    trade.finalR,
    trade.pnl,
    trade.mfe,
    trade.mae,
    trade.candlesHeld,
    csvSafe(trade.exitReason),
  ].join(","));
  const rejectedHeader = "setupId,setupType,setupState,direction,triggerIndex,rejectionReasons";
  const rejectedRows = rejectedSetups.map((setup) => [setup.setupId, setup.setupType, setup.setupState, setup.direction, setup.triggerIndex ?? "", csvSafe(setup.rejectionReasons.join("; "))].join(","));
  return {
    tradeJournalCsv: [tradeHeader, ...tradeRows].join("\n"),
    rejectedSetupsCsv: [rejectedHeader, ...rejectedRows].join("\n"),
    jsonReport: JSON.stringify({ symbol: input.symbol, timeframe: input.timeframe, startDate: input.startDate, endDate: input.endDate, trades }, null, 2),
    summaryText: `${input.symbol} ${input.timeframe} backtest: ${trades.length} trades, ${round(sumR(trades), 2)}R total.`,
  };
}

function targetToR(bullish: boolean, entry: number, target: number, risk: number): number {
  return bullish ? (target - entry) / risk : (entry - target) / risk;
}

function stopToR(bullish: boolean, entry: number, stop: number, risk: number): number {
  return bullish ? (stop - entry) / risk : (entry - stop) / risk;
}

function classifyResult(finalR: number, partialHit: boolean): BacktestTradeResult {
  if (Math.abs(finalR) <= 0.05) return "BREAKEVEN";
  if (finalR > 0) return partialHit ? "PARTIAL_WIN" : "WIN";
  return partialHit ? "PARTIAL_LOSS" : "LOSS";
}

function calibrationSettings(name: CalibrationResult["settingName"]): CalibrationSettings {
  if (name === "relaxed settings") return { minSignalScore: 60, minRR: 1.1, maxSetupCandles: 20, retracementMin: 0.25, retracementMax: 0.85, displacementAtrMultiplier: 0.55, maxStopAtrMultiplier: 5, sessionRequired: false, allowNeutralHTF: true, reversalRiskMax: "MEDIUM" };
  if (name === "strict settings") return { minSignalScore: 85, minRR: 2, maxSetupCandles: 8, retracementMin: 0.35, retracementMax: 0.65, displacementAtrMultiplier: 0.9, maxStopAtrMultiplier: 3, sessionRequired: true, allowNeutralHTF: false, reversalRiskMax: "LOW" };
  if (name === "custom settings") return { minSignalScore: 75, minRR: 1.5, maxSetupCandles: 12, retracementMin: 0.3, retracementMax: 0.75, displacementAtrMultiplier: 0.7, maxStopAtrMultiplier: 4, sessionRequired: false, allowNeutralHTF: true, reversalRiskMax: "MEDIUM" };
  return { minSignalScore: 75, minRR: 1.5, maxSetupCandles: 12, retracementMin: 0.3, retracementMax: 0.75, displacementAtrMultiplier: 0.7, maxStopAtrMultiplier: 4, sessionRequired: false, allowNeutralHTF: true, reversalRiskMax: "MEDIUM" };
}

function countReasons(reasons: string[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

function estimateRejectedOutcome(setup: RejectedSetup, candles: Candle[]): "WIN" | "LOSS" | "UNKNOWN" {
  if (setup.triggerIndex === null || setup.triggerIndex >= candles.length - 2 || (setup.direction !== "BULLISH" && setup.direction !== "BEARISH")) return "UNKNOWN";
  const entry = candles[setup.triggerIndex].close;
  const risk = Math.max(0.01, mean(candles.slice(Math.max(0, setup.triggerIndex - 10), setup.triggerIndex + 1).map((candle) => candle.high - candle.low)));
  for (const candle of candles.slice(setup.triggerIndex + 1, setup.triggerIndex + 21)) {
    if (setup.direction === "BULLISH") {
      if (candle.high >= entry + risk) return "WIN";
      if (candle.low <= entry - risk) return "LOSS";
    } else {
      if (candle.low <= entry - risk) return "WIN";
      if (candle.high >= entry + risk) return "LOSS";
    }
  }
  return "UNKNOWN";
}

function buildCacheKey(input: BacktestInput, settings: BacktestSettings, candles: Candle[]): string {
  const last = candles.at(-1);
  return [input.symbol, input.timeframe, input.startDate, input.endDate, settings.signalMode, candles.length, last?.timestamp ?? 0, input.signals.length, JSON.stringify(settings)].join(":");
}

function cloneResult(result: BacktestResult, cacheStatus: "hit" | "miss"): BacktestResult {
  return { ...result, tradeMap: new Map(result.tradeMap), audit: { ...result.audit, cacheStatus } };
}

function dateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function scoreBucket(score: number): string {
  if (score < 70) return "60-69";
  if (score < 80) return "70-79";
  if (score < 90) return "80-89";
  return "90-100";
}

function rrBucket(rr: number): string {
  if (rr < 1.2) return "1.0-1.2";
  if (rr < 1.5) return "1.2-1.5";
  if (rr < 2) return "1.5-2.0";
  return "2.0+";
}

function maxStreak(trades: BacktestTrade[], predicate: (trade: BacktestTrade) => boolean): number {
  let best = 0;
  let current = 0;
  for (const trade of trades) {
    current = predicate(trade) ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return best;
}

function sumR(trades: BacktestTrade[]): number {
  return round(trades.reduce((total, trade) => total + trade.finalR, 0), 3);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function csvSafe(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function roundPercent(value: number): number {
  return round(value * 100, 2);
}

function round(value: number, digits = 5): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
