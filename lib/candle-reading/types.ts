export type CandleClassification =
  | "STRONG_BULLISH"
  | "STRONG_BEARISH"
  | "WEAK_BULLISH"
  | "WEAK_BEARISH"
  | "DOJI"
  | "INDECISION"
  | "PIN_BAR_BULLISH"
  | "PIN_BAR_BEARISH"
  | "ENGULFING_BULLISH"
  | "ENGULFING_BEARISH"
  | "INSIDE_BAR"
  | "OUTSIDE_BAR"
  | "EXHAUSTION_CANDLE"
  | "DISPLACEMENT_CANDLE";

export type CandleDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type ConfidenceLabel = "LOW" | "MEDIUM" | "GOOD" | "STRONG";

export type CandleInterpretation = {
  index: number;
  sequenceNumber: number;
  timestamp: number;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bodySize: number;
  rangeSize: number;
  upperWick: number;
  lowerWick: number;
  closePosition: number;
  bodyRangeRatio: number;
  atr: number;
  atrRatio: number;
  direction: CandleDirection;
  primaryType: CandleClassification;
  classifications: CandleClassification[];
  control: "BUYERS" | "SELLERS" | "BALANCED";
  closeStrength: "STRONG" | "WEAK" | "NEUTRAL";
  rejection: "HIGH" | "LOW" | "BOTH" | "NONE";
  relationToPrevious: string;
  volumeContext: string;
  explanation: string;
};

export type CandleSequenceReading = {
  shortTermFlow: "BULLISH" | "BEARISH" | "RANGING" | "CHOPPY";
  momentumState: "INCREASING" | "DECREASING" | "EXHAUSTED" | "NEUTRAL";
  volatilityState: "EXPANDING" | "CONTRACTING" | "NORMAL";
  pressure: "BUYERS_ACTIVE" | "SELLERS_ACTIVE" | "BALANCED";
  features: string[];
  reason: string;
};

export type TraderQuestions = {
  lastCandleControl: string;
  closeQuality: string;
  rejection: string;
  volatility: string;
  momentum: string;
  breakoutTrap: string;
  liquiditySweep: string;
  extensionRisk: string;
  nextCandleExpectation: string;
  bullishConfirmation: string;
  bearishConfirmation: string;
  currentReadInvalidation: string;
};

export type CandleScenario = {
  probability: number;
  condition: string;
  expectedBehavior: string;
  invalidation: number;
};

export type NextCandleScenarios = {
  expectedBias: CandleDirection;
  bullishScenario: CandleScenario;
  bearishScenario: CandleScenario;
  neutralScenario: CandleScenario;
  confidence: number;
  warning: string;
};

export type ReversalWarning = {
  reversalRisk: "LOW" | "MEDIUM" | "HIGH";
  reasons: string[];
  avoidChasing: boolean;
};

export type ComponentScore = {
  total: number;
  label: ConfidenceLabel;
  components: Record<string, number>;
};

export type CandleReadingScores = {
  latestCandle: ComponentScore;
  sequence: ComponentScore;
  confidence: {
    score: number;
    label: ConfidenceLabel;
  };
};

export type CandleReadingResult = {
  analyzedCandleCount: number;
  windowStartTimestamp: number;
  windowEndTimestamp: number;
  marketMood: CandleSequenceReading["shortTermFlow"];
  latestCandle: CandleInterpretation;
  candles: CandleInterpretation[];
  sequence: CandleSequenceReading;
  questions: TraderQuestions;
  scenarios: NextCandleScenarios;
  reversalWarning: ReversalWarning;
  scores: CandleReadingScores;
  keyLevels: {
    previousHigh: number;
    previousLow: number;
    previousMidpoint: number;
    latestClose: number;
    bullishInvalidation: number;
    bearishInvalidation: number;
  };
  humanSummary: string;
};

export type CandleReadingOptions = {
  windowSize?: number;
  atrPeriod?: number;
};
