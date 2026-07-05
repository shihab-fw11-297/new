import type { Candle, Timeframe } from "../candles/types";
import type { CandleReadingResult } from "../candle-reading/types";
import type { MarketContextResult } from "../market-context/types";
import type {
  FvgZone,
  LiquidityZone,
  MarketStructureResult,
  MomentumMarker,
  StructureMarker,
  SweepMarker,
} from "../market-structure/types";

export type SetupType =
  | "LIQUIDITY_SWEEP_REVERSAL"
  | "TREND_CONTINUATION"
  | "COMPRESSION_BREAKOUT"
  | "RANGE_REVERSAL";

export type SetupDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type SetupState = "WATCH" | "SETUP" | "TRIGGER" | "INVALIDATED" | "EXPIRED";

export type SetupStateHistory = {
  from: SetupState;
  to: SetupState;
  timestamp: number;
  candleIndex: number;
  reason: string;
};

export type SetupZone = {
  type:
    | "FVG"
    | "ORDER_BLOCK_LIKE"
    | "DISPLACEMENT_50"
    | "PREMIUM_DISCOUNT"
    | "RANGE_RETEST"
    | "SWEPT_LIQUIDITY_RETEST";
  minPrice: number;
  maxPrice: number;
  midpoint: number;
  createdFrom: string;
  strength: number;
  reason: string;
};

export type SetupInvalidation = {
  price: number;
  source: "SWEEP_EXTREME" | "PULLBACK_EXTREME" | "RANGE_EDGE" | "STRUCTURE_EXTREME";
  reason: string;
};

export type SetupTarget = {
  targetType: string;
  price: number;
  distance: number;
  strength: number;
  reason: string;
};

export type SetupScoreBreakdown = {
  htfContext: number;
  itfQuality: number;
  liquidityQuality: number;
  sweepDisplacement: number;
  structureQuality: number;
  premiumDiscount: number;
  sessionQuality: number;
  volatilityQuality: number;
  candlePsychology: number;
};

export type AntiReversalResult = {
  reversalRisk: "LOW" | "MEDIUM" | "HIGH";
  warnings: string[];
  shouldAvoid: boolean;
};

export type MarketSetup = {
  id: string;
  type: SetupType;
  direction: SetupDirection;
  state: SetupState;
  createdAt: number;
  updatedAt: number;
  createdAtIndex: number;
  updatedAtIndex: number;
  sourceTimeframe: Timeframe;
  relatedHtfContext: string;
  relatedItfContext: string;
  relatedLtfCandles: number[];
  relatedLiquidity: LiquidityZone | null;
  relatedSweep: SweepMarker | null;
  relatedDisplacement: MomentumMarker | null;
  relatedStructure: StructureMarker | null;
  relatedFvg: FvgZone | null;
  setupZone: SetupZone;
  invalidationLevel: SetupInvalidation;
  targetLiquidity: SetupTarget | null;
  score: number;
  scoreBreakdown: SetupScoreBreakdown;
  reasons: string[];
  warnings: string[];
  failedReasons: string[];
  antiReversal: AntiReversalResult;
  history: SetupStateHistory[];
};

export type SetupScannerSettings = {
  maxSetupAgeBars: number;
  maxWatchAgeBars: number;
  proximityAtrMultiplier: number;
  extensionAtrMultiplier: number;
  maxActiveSetups: number;
};

export type SetupScannerInput = {
  candles: Candle[];
  symbol: string;
  timeframe: Timeframe;
  startDate: string;
  endDate: string;
  structure: MarketStructureResult;
  context: MarketContextResult;
  candleReading: CandleReadingResult | null;
  settings?: Partial<SetupScannerSettings>;
};

export type SetupScannerAudit = {
  processedCandles: number;
  currentCandleIndex: number;
  activeSetupCount: number;
  watchCount: number;
  setupCount: number;
  triggerCount: number;
  invalidatedCount: number;
  expiredCount: number;
  transitionCount: number;
  calculationTimeMs: number;
  cacheStatus: "hit" | "miss";
  noFutureValidation: "pass" | "warning";
};

export type SetupScannerResult = {
  setups: MarketSetup[];
  activeSetups: MarketSetup[];
  invalidatedSetups: MarketSetup[];
  expiredSetups: MarketSetup[];
  setupMap: Map<string, MarketSetup>;
  audit: SetupScannerAudit;
};
