import type { Candle, Timeframe } from "../candles/types";
import type { CandleReadingResult } from "../candle-reading/types";
import type { MarketContextResult, TradingSession } from "../market-context/types";
import type { MarketStructureResult } from "../market-structure/types";
import type { MarketSetup, SetupScannerResult, SetupType } from "../setup-scanner/types";

export type EntryMode = "CALIBRATION" | "EASY_SCALP" | "NORMAL_SCALP" | "PRO_TRADER";
export type SignalType = "CONFIRMED_BUY" | "CONFIRMED_SELL" | "RAPID_BUY" | "RAPID_SELL";
export type SignalStatus = "CONFIRMED" | "ACTIVE" | "INVALIDATED" | "TP_HIT" | "SL_HIT" | "EXPIRED";
export type SignalRejectionCode =
  | "DATA_NOT_ENOUGH"
  | "CONFIRMATION_PENDING"
  | "CONFIRMATION_WINDOW_EXPIRED"
  | "INVALIDATED_BEFORE_CONFIRMATION"
  | "HTF_CANDLES_MISSING"
  | "ITF_CANDLES_MISSING"
  | "HTF_BIAS_MISSING"
  | "HTF_OPPOSITE"
  | "CONTEXT_WAIT"
  | "MARKET_CHOPPY"
  | "NO_LIQUIDITY"
  | "NO_SWEEP"
  | "NO_DISPLACEMENT"
  | "NO_MSS"
  | "NO_RETRACEMENT"
  | "SETUP_NOT_TRIGGER"
  | "SCORE_TOO_LOW"
  | "RR_TOO_LOW"
  | "STOP_LOSS_INVALID"
  | "TAKE_PROFIT_NOT_FOUND"
  | "CONFIRMATION_CANDLE_MISSING"
  | "PRICE_TOO_EXTENDED"
  | "REVERSAL_RISK_HIGH"
  | "SESSION_LOW_QUALITY"
  | "VOLATILITY_BAD";

export type SignalScoreBreakdown = {
  phase4Setup: number;
  contextAlignment: number;
  confirmationCandle: number;
  stopLossQuality: number;
  targetQuality: number;
  sessionQuality: number;
  volatilityQuality: number;
  antiReversal: number;
};

export type StopLossResult = {
  price: number;
  source: string;
  buffer: number;
  riskPoints: number;
  reason: string;
};

export type TakeProfitResult = {
  tp1: number;
  tp2: number | null;
  tp3: number | null;
  source: string;
  rewardPoints: number;
  reason: string;
};

export type NoRepaintProof = {
  status: "PASS" | "WARNING";
  signalIndex: number;
  latestAllowedCandleIndex: number;
  usedMarkerIndexes: number[];
  usedContextCloseTimes: number[];
  usedSetupId: string;
  passed: boolean;
  lastAvailableIndex: number;
  maxEvidenceIndex: number;
  message: string;
};

export type ConfirmationStatus =
  | "CONFIRMED"
  | "PENDING_CONFIRMATION"
  | "EXPIRED_CONFIRMATION"
  | "INVALIDATED"
  | "REJECTED";

export type SignalCandidateDebug = {
  setupId: string;
  setupScore: number;
  requiredSetupScore: number;
  finalSignalScore: number | null;
  requiredSignalScore: number;
  confirmationStatus: ConfirmationStatus;
  confirmationWindowRemaining: number;
  rejectionReason: string;
  nextRequiredAction: string;
};

export type TradeSignal = {
  id: string;
  type: SignalType;
  direction: "BULLISH" | "BEARISH";
  status: SignalStatus;
  sourceSetupId: string;
  setupType: SetupType;
  strategyModel: string;
  mode: EntryMode;
  timestamp: number;
  candleIndex: number;
  confirmedAtIndex: number;
  timeframe: Timeframe;
  session: TradingSession;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  takeProfit2: number | null;
  takeProfit3: number | null;
  riskPoints: number;
  rewardPoints: number;
  rr: number;
  score: number;
  confidence: "LOW_CONFIRMED" | "MODERATE" | "STRONG" | "PREMIUM";
  positionSizeSuggestion: number;
  maxRiskAmount: number;
  invalidationLevel: number;
  reasons: string[];
  warnings: string[];
  rejectionReasons: string[];
  relatedMarkers: string[];
  noRepaintProof: NoRepaintProof;
  stopLossDetail: StopLossResult;
  takeProfitDetail: TakeProfitResult;
  scoreBreakdown: SignalScoreBreakdown;
};

export type NoTradeResult = {
  status: "NO_TRADE";
  checkedSetups: number;
  rejectionReasons: string[];
  message: string;
  nearestPossibleSetup: string | null;
  requiredForSignal: string[];
  timestamp: number | null;
};

export type EntryEngineSettings = {
  maxRiskAmount: number;
  atrBufferMultiplier: number;
  confirmationWindowCandles: number;
  maxConfirmationBars: number;
  maxSignalAgeBars: number;
};

export type EntryEngineInput = {
  candles: Candle[];
  symbol: string;
  timeframe: Timeframe;
  startDate: string;
  endDate: string;
  mode: EntryMode;
  setupScanner: SetupScannerResult;
  context: MarketContextResult;
  structure: MarketStructureResult;
  candleReading: CandleReadingResult | null;
  settings?: Partial<EntryEngineSettings>;
};

export type RejectedSetup = {
  setupId: string;
  setupType: SetupType;
  setupState: MarketSetup["state"];
  direction: MarketSetup["direction"];
  triggerIndex: number | null;
  rejectionReasons: string[];
  rejectionReasonCodes: SignalRejectionCode[];
  debug?: SignalCandidateDebug;
};

export type SignalEngineAudit = {
  activeMode: EntryMode;
  minimumScoreRequired: number;
  minimumSetupScoreRequired: number;
  minimumSignalScoreRequired: number;
  minimumRrRequired: number;
  totalCandlesScanned: number;
  totalMarkersGenerated: number;
  totalContextsGenerated: number;
  totalPhase4Setups: number;
  watchCount: number;
  setupCount: number;
  invalidatedCount: number;
  expiredCount: number;
  totalSetupsScanned: number;
  triggerSetupsFound: number;
  pendingConfirmationCount: number;
  expiredConfirmationCount: number;
  invalidatedCandidateCount: number;
  confirmedBuyCount: number;
  confirmedSellCount: number;
  rapidBuyCount: number;
  rapidSellCount: number;
  rapidSignalCount: number;
  rejectedSetupCount: number;
  lastRejectionReason: string | null;
  lastConfirmedSignal: string | null;
  topRejectionReasons: Array<{ reason: string; count: number }>;
  lastFiveTriggerSetups: string[];
  lastFiveConfirmedSignals: string[];
  noSignalMessage: string | null;
  noRepaintWarnings: string[];
  rrCalculation: string | null;
  stopLossSource: string | null;
  takeProfitSource: string | null;
  scoreBreakdown: SignalScoreBreakdown | null;
  lastCandidateDebug: SignalCandidateDebug | null;
  noRepaintValidation: "PASS" | "WARNING";
  calculationTimeMs: number;
  generationTimeMs: number;
  cacheStatus: "hit" | "miss";
};

export type EntryEngineResult = {
  signals: TradeSignal[];
  activeSignals: TradeSignal[];
  signalMap: Map<string, TradeSignal>;
  pendingCandidates: SignalCandidateDebug[];
  candidateDebug: SignalCandidateDebug[];
  rejectedSetups: RejectedSetup[];
  noTrade: NoTradeResult | null;
  audit: SignalEngineAudit;
};

export type SignalEvaluation = {
  setup: MarketSetup;
  signal: TradeSignal | null;
  rejectionReasons: string[];
  confirmationStatus: ConfirmationStatus;
  debug: SignalCandidateDebug;
};
