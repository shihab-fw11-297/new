import type { EntryMode, SignalRejectionCode } from "../entry-engine/types";
import type { SetupType } from "../setup-scanner/types";

export type SignalFunnelCounts = {
  totalCandles: number;
  validClosedCandles: number;
  ltfCandles: number;
  itfCandles: number;
  htfCandles: number;
  swingHighCount: number;
  swingLowCount: number;
  bslCount: number;
  sslCount: number;
  sweepCount: number;
  displacementCount: number;
  buyersCount: number;
  sellersCount: number;
  bosCount: number;
  chochCount: number;
  mssCount: number;
  fvgCount: number;
  contextCount: number;
  bullishContextCount: number;
  bearishContextCount: number;
  neutralContextCount: number;
  waitContextCount: number;
  watchSetupCount: number;
  setupCount: number;
  triggerSetupCount: number;
  invalidatedSetupCount: number;
  expiredSetupCount: number;
  pendingConfirmationCount: number;
  expiredConfirmationCount: number;
  invalidatedCandidateCount: number;
  confirmedBuyCount: number;
  confirmedSellCount: number;
  rejectedSignalCount: number;
  backtestTradeCount: number;
};

export type RejectionHistogramRow = {
  reason: SignalRejectionCode;
  count: number;
  percentage: number;
  exampleTime: string | null;
  exampleDetails: string;
};

export type FunnelScanDebug = {
  firstScannedCandleTime: string | null;
  lastScannedCandleTime: string | null;
  scannedCandleCount: number;
  scanMode: "FULL_HISTORY";
};

export type TriggerDiagnosticsRow = {
  setupId: string;
  direction: string;
  setupType: SetupType;
  score: number;
  requiredSetupScore: number;
  finalSignalScore: number | null;
  requiredSignalScore: number;
  confirmationStatus: string;
  confirmationWindowRemaining: number;
  entryCandidate: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  rr: number | null;
  mode: EntryMode;
  rejected: boolean;
  rejectionReason: string;
  nextRequiredAction: string;
};

export type GoldUnitDiagnostics = {
  currentPrice: number | null;
  signalEntryPrice: number | null;
  atr: number | null;
  averageCandleRange: number | null;
  stopDistance: number | null;
  targetDistance: number | null;
  rr: number | null;
  minAllowedStop: number | null;
  maxAllowedStop: number | null;
};

export type SignalFunnelResult = {
  counts: SignalFunnelCounts;
  zeroCountExplanations: string[];
  topRejectionReasons: RejectionHistogramRow[];
  scan: FunnelScanDebug;
  triggerDiagnostics: TriggerDiagnosticsRow[];
  goldUnits: GoldUnitDiagnostics;
  blocker: string;
};
