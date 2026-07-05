import { memo } from "react";

import type { EntryEngineResult, EntryMode, TradeSignal } from "@/lib/entry-engine/types";

type SignalDebugPanelProps = {
  result: EntryEngineResult;
  selectedSignal: TradeSignal | null;
  cacheStatusLabel: string;
  generationTimeLabel: string;
};

function SignalDebugPanelComponent({ result, selectedSignal, cacheStatusLabel, generationTimeLabel }: SignalDebugPanelProps) {
  const signal = selectedSignal ?? result.signals.at(-1) ?? null;
  const audit = result.audit;

  return (
    <section className="border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold uppercase text-slate-700">Signal Debug</h2>
          <p className="mt-1 text-xs text-slate-500">Confirmed entries only</p>
        </div>
        <span className="border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700">
          {formatLabel(audit.activeMode)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-px bg-slate-200 text-xs">
        <Metric label="Candles scanned" value={audit.totalCandlesScanned} />
        <Metric label="Markers generated" value={audit.totalMarkersGenerated} />
        <Metric label="Contexts generated" value={audit.totalContextsGenerated} />
        <Metric label="Phase 4 setups" value={audit.totalPhase4Setups} />
        <Metric label="WATCH" value={audit.watchCount} />
        <Metric label="SETUP" value={audit.setupCount} />
        <Metric label="Setups scanned" value={audit.totalSetupsScanned} />
        <Metric label="Triggers found" value={audit.triggerSetupsFound} />
        <Metric label="INVALIDATED" value={audit.invalidatedCount} />
        <Metric label="EXPIRED" value={audit.expiredCount} />
        <Metric label="Confirmed BUY" value={audit.confirmedBuyCount} />
        <Metric label="Confirmed SELL" value={audit.confirmedSellCount} />
        <Metric label="Rapid BUY" value={audit.rapidBuyCount} />
        <Metric label="Rapid SELL" value={audit.rapidSellCount} />
        <Metric label="Rapid signals" value={audit.rapidSignalCount} />
        <Metric label="Rejected" value={audit.rejectedSetupCount} />
        <Metric label="Pending confirm" value={audit.pendingConfirmationCount} />
        <Metric label="Expired confirm" value={audit.expiredConfirmationCount} />
        <Metric label="Invalidated candidates" value={audit.invalidatedCandidateCount} />
        <Metric label="Min setup score" value={audit.minimumSetupScoreRequired} />
        <Metric label="Min signal score" value={audit.minimumSignalScoreRequired} />
        <Metric label="Min RR" value={`${audit.minimumRrRequired.toFixed(1)}R`} />
        <Metric label="Generation ms" value={generationTimeLabel} />
        <Metric label="No repaint" value={audit.noRepaintValidation} />
        <Metric label="Cache" value={cacheStatusLabel} />
      </div>

      <ModeConfigDetail mode={audit.activeMode} />

      {signal ? <SignalDetail signal={signal} /> : <NoTradeDetail result={result} />}

      <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-600">
        {audit.noSignalMessage ? <p className="mb-2 font-semibold text-amber-700">{audit.noSignalMessage}</p> : null}
        <p><strong className="text-slate-800">Last rejection:</strong> {audit.lastRejectionReason ?? "None"}</p>
        <p className="mt-1"><strong className="text-slate-800">RR:</strong> {audit.rrCalculation ?? "Not available"}</p>
        <p className="mt-1"><strong className="text-slate-800">SL source:</strong> {audit.stopLossSource ?? "Not available"}</p>
        <p className="mt-1"><strong className="text-slate-800">TP source:</strong> {audit.takeProfitSource ?? "Not available"}</p>
        <DebugList title="Top rejection reasons" values={audit.topRejectionReasons.map((item) => `${item.reason} (${item.count})`)} />
        <DebugList title="Last trigger setups" values={audit.lastFiveTriggerSetups} />
        <DebugList title="Last confirmed signals" values={audit.lastFiveConfirmedSignals} />
        <CandidateDebugList values={result.candidateDebug.slice(-8)} />
        <DebugList title="No-repaint warnings" values={audit.noRepaintWarnings} />
      </div>
    </section>
  );
}

export const SignalDebugPanel = memo(SignalDebugPanelComponent);

function ModeConfigDetail({ mode }: { mode: EntryMode }) {
  // Mode configuration details based on mode
  const modeDetails: Record<EntryMode, { goal: string; setupScore: number; signalScore: number; minRR: number; allowNeutral: boolean; rejectOpposite: boolean; window: number }> = {
    CALIBRATION: {
      goal: "Debug signal pipeline",
      setupScore: 40,
      signalScore: 45,
      minRR: 1.0,
      allowNeutral: true,
      rejectOpposite: false,
      window: 4,
    },
    EASY_SCALP: {
      goal: "Signal discovery/testing",
      setupScore: 50,
      signalScore: 55,
      minRR: 1.2,
      allowNeutral: true,
      rejectOpposite: false,
      window: 3,
    },
    NORMAL_SCALP: {
      goal: "Practical trading mode",
      setupScore: 55,
      signalScore: 60,
      minRR: 1.5,
      allowNeutral: true,
      rejectOpposite: true,
      window: 3,
    },
    PRO_TRADER: {
      goal: "High-quality only",
      setupScore: 75,
      signalScore: 80,
      minRR: 2.0,
      allowNeutral: false,
      rejectOpposite: true,
      window: 2,
    },
  };

  const config = modeDetails[mode];
  
  return (
    <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
      <p className="font-semibold text-slate-900">{formatLabel(mode)} Mode</p>
      <p className="mt-1 text-slate-600">Goal: {config.goal}</p>
      {mode === "CALIBRATION" && <p className="mt-1 font-semibold text-red-700">⚠️ Calibration mode is for debugging only, not live trading.</p>}
      <div className="mt-2 grid grid-cols-4 gap-2">
        <span>Min setup: {config.setupScore}</span>
        <span>Min signal: {config.signalScore}</span>
        <span>Min RR: {config.minRR.toFixed(1)}</span>
        <span>Window: {config.window}c</span>
        <span>Allow neutral HTF: {config.allowNeutral ? "Yes" : "No"}</span>
        <span>Reject opposite HTF: {config.rejectOpposite ? "Yes" : "No"}</span>
      </div>
    </div>
  );
}

function SignalDetail({ signal }: { signal: TradeSignal }) {
  return (
    <div className="px-4 py-4 text-xs text-slate-700">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`px-2 py-1 font-bold text-white ${signal.direction === "BULLISH" ? "bg-emerald-700" : "bg-red-700"}`}>
          {formatLabel(signal.type)}
        </span>
        <span className="font-semibold">{signal.status}</span>
        <span>{signal.score}/100</span>
        <span>{formatLabel(signal.confidence)}</span>
      </div>
      <p className="mt-3 font-semibold text-slate-900">{signal.strategyModel}</p>
      <p className="mt-1 text-slate-500">Source: {signal.sourceSetupId}</p>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <Value label="Entry" value={formatPrice(signal.entryPrice)} />
        <Value label="RR" value={`${signal.rr.toFixed(2)}R`} />
        <Value label="Stop loss" value={formatPrice(signal.stopLoss)} />
        <Value label="TP1" value={formatPrice(signal.takeProfit)} />
        <Value label="TP2" value={formatOptionalPrice(signal.takeProfit2)} />
        <Value label="TP3" value={formatOptionalPrice(signal.takeProfit3)} />
        <Value label="Invalidation" value={formatPrice(signal.invalidationLevel)} />
        <Value label="Risk units" value={signal.positionSizeSuggestion.toFixed(4)} />
      </div>
      <p className="mt-3"><strong className="text-slate-900">Reasons:</strong> {signal.reasons.join(" ")}</p>
      <p className="mt-2"><strong className="text-slate-900">Warnings:</strong> {signal.warnings.join(" ") || "None"}</p>
      <p className="mt-2"><strong className="text-slate-900">Evidence:</strong> {signal.relatedMarkers.join(", ") || "Setup evidence"}</p>
      <p className="mt-2"><strong className="text-slate-900">No repaint:</strong> {signal.noRepaintProof.message}</p>
      <ScoreBreakdown breakdown={signal.scoreBreakdown} />
    </div>
  );
}

function NoTradeDetail({ result }: { result: EntryEngineResult }) {
  const noTrade = result.noTrade;
  if (!noTrade) return null;
  return (
    <div className="px-4 py-4 text-xs text-slate-700">
      <p className="font-bold text-slate-900">NO TRADE</p>
      <p className="mt-2 font-medium text-amber-700">{noTrade.message}</p>
      <p className="mt-2">{noTrade.nearestPossibleSetup ?? "No nearby setup"}</p>
      <ul className="mt-3 space-y-1 border-l-2 border-amber-400 pl-3">
        {noTrade.rejectionReasons.slice(0, 6).map((reason) => <li key={reason}>{reason}</li>)}
      </ul>
      <p className="mt-3 font-semibold text-slate-800">Required for signal</p>
      <ul className="mt-1 space-y-1 text-slate-600">
        {noTrade.requiredForSignal.map((requirement) => <li key={requirement}>{requirement}</li>)}
      </ul>
    </div>
  );
}

function ScoreBreakdown({ breakdown }: { breakdown: TradeSignal["scoreBreakdown"] }) {
  return (
    <div className="mt-3 border-t border-slate-200 pt-3">
      <p className="font-semibold text-slate-900">Score breakdown</p>
      <div className="mt-2 grid grid-cols-2 gap-1 text-slate-600">
        {Object.entries(breakdown).map(([key, value]) => (
          <span key={key}>{formatLabel(key)}: {value}</span>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="bg-white px-3 py-2"><span className="block text-slate-500">{label}</span><strong className="mt-1 block text-slate-900">{value}</strong></div>;
}

function DebugList({ title, values }: { title: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="mt-3 border-t border-slate-100 pt-2">
      <p className="font-semibold text-slate-800">{title}</p>
      <ul className="mt-1 space-y-1">
        {values.slice(0, 10).map((value) => <li key={value}>{value}</li>)}
      </ul>
    </div>
  );
}

function CandidateDebugList({ values }: { values: EntryEngineResult["candidateDebug"] }) {
  if (values.length === 0) return null;
  return (
    <div className="mt-3 border-t border-slate-100 pt-2">
      <p className="font-semibold text-slate-800">Rejected / Pending Candidate Debug</p>
      <div className="mt-2 max-h-56 overflow-auto">
        <table className="min-w-190 w-full text-left text-xs">
          <thead className="bg-slate-100 text-slate-600">
            <tr>{["Setup", "Setup score", "Req setup", "Final score", "Req signal", "Status", "Window", "Reason", "Next action"].map((item) => <th key={item} className="px-2 py-1 font-semibold">{item}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {values.map((item) => (
              <tr key={`${item.setupId}-${item.confirmationStatus}-${item.rejectionReason}`}>
                <td className="px-2 py-1">{item.setupId}</td>
                <td className="px-2 py-1">{item.setupScore}</td>
                <td className="px-2 py-1">{item.requiredSetupScore}</td>
                <td className="px-2 py-1">{item.finalSignalScore ?? "-"}</td>
                <td className="px-2 py-1">{item.requiredSignalScore}</td>
                <td className="px-2 py-1 font-semibold">{formatLabel(item.confirmationStatus)}</td>
                <td className="px-2 py-1">{item.confirmationWindowRemaining}</td>
                <td className="px-2 py-1">{item.rejectionReason}</td>
                <td className="px-2 py-1">{item.nextRequiredAction}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return <span><span className="text-slate-500">{label}</span><strong className="block text-slate-900">{value}</strong></span>;
}

function formatLabel(value: EntryMode | string): string {
  return value.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatPrice(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 5 });
}

function formatOptionalPrice(value: number | null): string {
  return value === null ? "-" : formatPrice(value);
}
