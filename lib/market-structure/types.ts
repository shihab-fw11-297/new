import type { Candle, Timeframe } from "@/lib/candles/types";

export type MarkerDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type StructureDirection = "BULLISH" | "BEARISH" | "RANGING" | "UNKNOWN";
export type MarkerStrength = 1 | 2 | 3;
export type MarkerSensitivity = "low" | "normal" | "high";

export type MarketStructureSettings = {
  sensitivity: MarkerSensitivity;
  leftBars: number;
  rightBars: number;
  atrPeriod: number;
  showOnlyMajor: boolean;
};

export type MarkerVisibility = {
  swings: boolean;
  liquidity: boolean;
  sweeps: boolean;
  momentum: boolean;
  pressure: boolean;
  structure: boolean;
  fvg: boolean;
};

export type BaseMarketMarker = {
  id: string;
  type:
    | "SWING_HIGH"
    | "SWING_LOW"
    | "SSL_SWEEP"
    | "BSL_SWEEP"
    | "MOMENTUM"
    | "DISPLACEMENT"
    | "BUYERS"
    | "SELLERS"
    | "BOS"
    | "CHOCH"
    | "MSS"
    | "FVG";
  timestamp: number;
  price: number;
  direction: MarkerDirection;
  strength: MarkerStrength;
  reason: string;
  confirmedAtIndex: number;
  confirmedAtTimestamp: number;
  sourceIndexes: number[];
};

export type SwingMarker = BaseMarketMarker & {
  type: "SWING_HIGH" | "SWING_LOW";
  candleIndex: number;
};

export type LiquidityZone = {
  id: string;
  type: "BSL" | "SSL";
  price: number;
  minPrice: number;
  maxPrice: number;
  startIndex: number;
  endIndex: number;
  timestamp: number;
  strength: MarkerStrength;
  touches: number;
  swept: boolean;
  sweptAt?: number;
  sweptAtIndex?: number;
  reason: string;
  confirmedAtIndex: number;
  confirmedAtTimestamp: number;
  sourceIndexes: number[];
};

export type SweepMarker = BaseMarketMarker & {
  type: "SSL_SWEEP" | "BSL_SWEEP";
  direction: "BULLISH" | "BEARISH";
  sweptLiquidityId: string;
  sweepIndex: number;
  sweepPrice: number;
  closePrice: number;
  rejectionStrength: number;
  atrDistance: number;
  sweepKind: "WICK_SWEEP" | "CLOSE_THROUGH" | "DEEP_SWEEP";
};

export type MomentumMarker = BaseMarketMarker & {
  type: "MOMENTUM" | "DISPLACEMENT";
  direction: "BULLISH" | "BEARISH";
  index: number;
  bodySize: number;
  rangeSize: number;
  atr: number;
  closePosition: number;
};

export type PressureMarker = BaseMarketMarker & {
  type: "BUYERS" | "SELLERS";
  direction: "BULLISH" | "BEARISH";
  index: number;
  relatedSweepId?: string;
  relatedMomentumId: string;
};

export type StructureMarker = BaseMarketMarker & {
  type: "BOS" | "CHOCH" | "MSS";
  direction: "BULLISH" | "BEARISH";
  breakIndex: number;
  breakPrice: number;
  brokenSwingId: string;
  previousStructure: StructureDirection;
  newStructure: StructureDirection;
  confirmed: boolean;
};

export type FvgZone = BaseMarketMarker & {
  type: "FVG";
  direction: "BULLISH" | "BEARISH";
  startIndex: number;
  middleIndex: number;
  endIndex: number;
  minPrice: number;
  maxPrice: number;
  createdAt: number;
  mitigated: boolean;
  mitigatedAt?: number;
  mitigatedAtIndex?: number;
};

export type MarketMarker =
  | SwingMarker
  | SweepMarker
  | MomentumMarker
  | PressureMarker
  | StructureMarker
  | FvgZone;

export type MarketStructureAudit = {
  totalCandles: number;
  totalSwingHighs: number;
  totalSwingLows: number;
  totalBslZones: number;
  totalSslZones: number;
  totalEqualHighZones: number;
  totalEqualLowZones: number;
  totalSweeps: number;
  totalSslSweeps: number;
  totalBslSweeps: number;
  totalMomentumCandles: number;
  totalBullishMomentum: number;
  totalBearishMomentum: number;
  totalBuyersMarkers: number;
  totalSellersMarkers: number;
  totalBos: number;
  totalChoch: number;
  totalMss: number;
  totalFvg: number;
  totalMitigatedFvg: number;
  calculationTimeMs: number;
  lastMarkerCreated: string | null;
  currentStructureState: StructureDirection;
  markerSensitivitySettings: MarketStructureSettings;
  cacheStatus: "hit" | "miss";
  validationWarnings: string[];
  noRepaintValidationStatus: "pass" | "warning";
};

export type MarketStructureResult = {
  candles: Candle[];
  markers: MarketMarker[];
  markerMap: Map<string, MarketMarker>;
  liquidityZones: LiquidityZone[];
  liquidityZoneMap: Map<string, LiquidityZone>;
  fvgZones: FvgZone[];
  atr: number[];
  audit: MarketStructureAudit;
};

export type MarkerEngineInput = {
  candles: Candle[];
  symbol: string;
  timeframe: Timeframe;
  startDate: string;
  endDate: string;
  settings: MarketStructureSettings;
};

export type ReplayState = {
  enabled: boolean;
  playing: boolean;
  speed: 1 | 2 | 5 | 10;
  index: number;
};
