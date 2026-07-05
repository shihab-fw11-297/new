import type { Candle, Timeframe } from "../candles/types";
import type { MarketStructureSettings, StructureDirection } from "../market-structure/types";

export type ContextTimeframe = Timeframe | "4h" | "1d";

export type TimeframeMapping = {
  ltf: ContextTimeframe;
  itf: ContextTimeframe;
  htf: ContextTimeframe;
  modeName: "1M SCALPING" | "5M SCALPING" | "15M INTRADAY" | "1H SWING";
};

export type AggregatedCandle = Candle & {
  closeTime: number;
  sourceStartIndex: number;
  sourceEndIndex: number;
};

export type HtfBias = {
  bias: "BULLISH" | "BEARISH" | "NEUTRAL" | "RANGING" | "UNKNOWN";
  strength: number;
  structureState: StructureDirection;
  lastBos: string | null;
  lastChoch: string | null;
  majorSwingHigh: number | null;
  majorSwingLow: number | null;
  reason: string;
  warnings: string[];
};

export type ItfSetupState =
  | "NO_SETUP"
  | "LIQUIDITY_BUILDING"
  | "SWEEP_FORMING"
  | "SWEEP_CONFIRMED"
  | "DISPLACEMENT_CONFIRMED"
  | "MSS_CONFIRMED"
  | "PULLBACK_FORMING"
  | "READY_FOR_LTF_TRIGGER"
  | "INVALIDATED";

export type ItfSetupContext = {
  setupState: ItfSetupState;
  direction: "BULLISH" | "BEARISH" | "MIXED" | "NONE";
  strength: number;
  relatedLiquidity: string | null;
  relatedSweep: string | null;
  relatedDisplacement: string | null;
  relatedStructure: string | null;
  pullbackZone: { minPrice: number; maxPrice: number } | null;
  reason: string;
  invalidation: number | null;
};

export type ItfEvidence = {
  direction: ItfSetupContext["direction"];
  liquidityId?: string;
  sweepProximity?: boolean;
  sweepId?: string;
  displacementId?: string;
  structureId?: string;
  pullbackZone?: { minPrice: number; maxPrice: number };
  invalidated?: boolean;
  invalidation?: number;
};

export type PremiumDiscountContext = {
  rangeHigh: number;
  rangeLow: number;
  equilibrium: number;
  currentPositionPercent: number;
  zone: "DEEP_PREMIUM" | "PREMIUM" | "EQUILIBRIUM" | "DISCOUNT" | "DEEP_DISCOUNT";
  buyQuality: number;
  sellQuality: number;
  reason: string;
};

export type KeyLevelType =
  | "MAJOR_SWING_HIGH"
  | "MAJOR_SWING_LOW"
  | "BSL"
  | "SSL"
  | "EQUAL_HIGH"
  | "EQUAL_LOW"
  | "FVG"
  | "PREVIOUS_SESSION_HIGH"
  | "PREVIOUS_SESSION_LOW"
  | "PREVIOUS_DAY_HIGH"
  | "PREVIOUS_DAY_LOW"
  | "CURRENT_RANGE_HIGH"
  | "CURRENT_RANGE_LOW";

export type KeyLevel = {
  id: string;
  type: KeyLevelType;
  timeframe: "LTF" | "ITF" | "HTF";
  price: number;
  minPrice: number;
  maxPrice: number;
  strength: number;
  touchedCount: number;
  lastTouchedAt: number;
  swept: boolean;
  distanceFromCurrentPrice: number;
  reason: string;
};

export type NearestLevels = {
  nearestResistance: KeyLevel | null;
  nearestSupport: KeyLevel | null;
  nearestBSL: KeyLevel | null;
  nearestSSL: KeyLevel | null;
  distanceToResistance: number | null;
  distanceToSupport: number | null;
};

export type MarketRegime = {
  regime:
    | "TRENDING_BULLISH"
    | "TRENDING_BEARISH"
    | "RANGING"
    | "CHOPPY"
    | "BREAKOUT"
    | "FAKE_BREAKOUT"
    | "LIQUIDITY_GRAB"
    | "REVERSAL_FORMING"
    | "MOMENTUM_EXPANSION"
    | "COMPRESSION"
    | "LOW_VOLATILITY"
    | "HIGH_VOLATILITY"
    | "WAIT";
  confidence: number;
  trendQuality: number;
  rangeQuality: number;
  volatilityQuality: number;
  chopRisk: number;
  reason: string;
  warnings: string[];
};

export type RegimeMetrics = {
  flow: "BULLISH" | "BEARISH" | "RANGING" | "CHOPPY";
  volatility: "LOW_VOLATILITY" | "NORMAL_VOLATILITY" | "HIGH_VOLATILITY" | "EXTREME_VOLATILITY";
  overlapRatio: number;
  alternatingRatio: number;
  displacementRatio: number;
  structureBreaks: number;
  compression: boolean;
  expansion: boolean;
  failedBreakout: boolean;
  liquidityGrab: boolean;
  reversalAttempt: boolean;
  enoughData: boolean;
};

export type TradingSession = "ASIAN" | "LONDON" | "NEW_YORK" | "LONDON_NEW_YORK_OVERLAP" | "DEAD_ZONE";

export type SessionContext = {
  session: TradingSession;
  displayTimezone: string;
  sessionQuality: number;
  sessionOpen: number | null;
  sessionClose: number | null;
  currentSessionHigh: number | null;
  currentSessionLow: number | null;
  previousSessionHigh: number | null;
  previousSessionLow: number | null;
  sessionBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  reason: string;
};

export type VolatilityContext = {
  state: "LOW_VOLATILITY" | "NORMAL_VOLATILITY" | "HIGH_VOLATILITY" | "EXTREME_VOLATILITY";
  atr: number;
  atrPercentile: number;
  averageRange: number;
  expansionRatio: number;
  warning: string | null;
  reason: string;
};

export type ContextScore = {
  overallScore: number;
  directionPreference: "BULLISH" | "BEARISH" | "NEUTRAL" | "WAIT";
  tradeEnvironment: "GOOD" | "MODERATE" | "POOR" | "WAIT";
  reason: string;
  warnings: string[];
};

export type WaitContext = {
  shouldWait: boolean;
  waitReasons: string[];
  requiredForImprovement: string[];
};

export type CandleTimeContext = {
  ltfCandle: Candle | null;
  latestClosedItfCandle: AggregatedCandle | null;
  latestClosedHtfCandle: AggregatedCandle | null;
  validContext: boolean;
};

export type MarketContextResult = {
  mapping: TimeframeMapping;
  itfCandles: AggregatedCandle[];
  htfCandles: AggregatedCandle[];
  htfBias: HtfBias;
  itfSetup: ItfSetupContext;
  premiumDiscount: PremiumDiscountContext | null;
  levels: KeyLevel[];
  nearestLevels: NearestLevels;
  regime: MarketRegime;
  session: SessionContext;
  volatility: VolatilityContext;
  score: ContextScore;
  wait: WaitContext;
  cacheStatus: "hit" | "miss";
};

export type MarketContextInput = {
  candles: Candle[];
  symbol: string;
  timeframe: Timeframe;
  startDate: string;
  endDate: string;
  marketStructureSettings: MarketStructureSettings;
  displayTimezone?: string;
};

export type ContextOverlayVisibility = {
  dealingRange: boolean;
  premiumDiscount: boolean;
  nearestLevels: boolean;
  sessionLevels: boolean;
  contextLabels: boolean;
};
