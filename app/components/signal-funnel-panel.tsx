import { memo } from "react";
import type { ReactNode } from "react";

import type { SignalFunnelResult } from "@/lib/signal-funnel/types";

type SignalFunnelPanelProps = {
  funnel: SignalFunnelResult;
};

function SignalFunnelPanelComponent({ funnel }: SignalFunnelPanelProps) {
  const counts = funnel.counts;
  return (
    <section className="border border-slate-200 bg-white">
      <div className="flex flex-col gap-2 border-b border-slate-200 px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase text-slate-700">Signal Funnel</h2>
          <p className="mt-1 text-xs font-semibold text-amber-700">{funnel.blocker}</p>
        </div>
        <span className="text-xs text-slate-500">
          {funnel.scan.scanMode} | {funnel.scan.scannedCandleCount} candles
        </span>
      </div>

      <div className="grid grid-cols-2 gap-px bg-slate-200 text-xs md:grid-cols-4 xl:grid-cols-6">
        {Object.entries(counts).map(([key, value]) => (
          <Metric key={key} label={formatLabel(key)} value={value} warn={value === 0} />
        ))}
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-2">
        <Panel title="Zero Count Explanations">
          {funnel.zeroCountExplanations.length ? (
            <ul className="space-y-1 text-xs text-slate-700">
              {funnel.zeroCountExplanations.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : (
            <p className="text-xs text-emerald-700">No zero-count pipeline blockers detected.</p>
          )}
        </Panel>

        <Panel title="Full History Scan">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Value label="First scanned" value={funnel.scan.firstScannedCandleTime ?? "-"} />
            <Value label="Last scanned" value={funnel.scan.lastScannedCandleTime ?? "-"} />
            <Value label="Candles scanned" value={String(funnel.scan.scannedCandleCount)} />
            <Value label="Mode" value={funnel.scan.scanMode} />
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 px-4 pb-4 xl:grid-cols-2">
        <Panel title="Top Rejection Reasons">
          <div className="max-h-64 overflow-auto">
            <table className="min-w-[720px] w-full text-left text-xs">
              <thead className="bg-slate-100 text-slate-600">
                <tr>{["Reason", "Count", "%", "Example time", "Example details"].map((item) => <th key={item} className="px-3 py-2 font-semibold">{item}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {funnel.topRejectionReasons.map((row) => (
                  <tr key={row.reason}>
                    <td className="px-3 py-2 font-semibold">{row.reason}</td>
                    <td className="px-3 py-2">{row.count}</td>
                    <td className="px-3 py-2">{row.percentage.toFixed(2)}%</td>
                    <td className="px-3 py-2">{row.exampleTime ?? "-"}</td>
                    <td className="px-3 py-2">{row.exampleDetails}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {funnel.topRejectionReasons.length === 0 ? <p className="py-4 text-center text-sm text-slate-500">No Phase 5 rejected setup reasons yet.</p> : null}
          </div>
        </Panel>

        <Panel title="Gold Price Units">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Value label="Current price" value={formatNumber(funnel.goldUnits.currentPrice)} />
            <Value label="Signal entry" value={formatNumber(funnel.goldUnits.signalEntryPrice)} />
            <Value label="Signal ATR" value={formatNumber(funnel.goldUnits.atr)} />
            <Value label="Signal-window average range" value={formatNumber(funnel.goldUnits.averageCandleRange)} />
            <Value label="Stop distance" value={formatNumber(funnel.goldUnits.stopDistance)} />
            <Value label="Target distance" value={formatNumber(funnel.goldUnits.targetDistance)} />
            <Value label="RR" value={formatNumber(funnel.goldUnits.rr)} />
            <Value label="Min allowed stop" value={formatNumber(funnel.goldUnits.minAllowedStop)} />
            <Value label="Max allowed stop" value={formatNumber(funnel.goldUnits.maxAllowedStop)} />
          </div>
        </Panel>
      </div>

      <div className="px-4 pb-4">
        <Panel title="Last 20 Trigger Setup Diagnostics">
          <div className="max-h-72 overflow-auto">
            <table className="min-w-[1320px] w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-100 text-slate-600">
                <tr>{["Setup", "Direction", "Type", "Setup score", "Req setup", "Final score", "Req signal", "Status", "Window", "Entry", "SL", "TP", "RR", "Mode", "Rejected", "Reason", "Next action"].map((item) => <th key={item} className="px-3 py-2 font-semibold">{item}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {funnel.triggerDiagnostics.map((row) => (
                  <tr key={row.setupId}>
                    <td className="px-3 py-2">{row.setupId}</td>
                    <td className="px-3 py-2">{row.direction}</td>
                    <td className="px-3 py-2">{formatLabel(row.setupType)}</td>
                    <td className="px-3 py-2">{row.score}</td>
                    <td className="px-3 py-2">{row.requiredSetupScore || "-"}</td>
                    <td className="px-3 py-2">{row.finalSignalScore ?? "-"}</td>
                    <td className="px-3 py-2">{row.requiredSignalScore || "-"}</td>
                    <td className="px-3 py-2">{formatLabel(row.confirmationStatus)}</td>
                    <td className="px-3 py-2">{row.confirmationWindowRemaining}</td>
                    <td className="px-3 py-2">{formatNumber(row.entryCandidate)}</td>
                    <td className="px-3 py-2">{formatNumber(row.stopLoss)}</td>
                    <td className="px-3 py-2">{formatNumber(row.takeProfit)}</td>
                    <td className="px-3 py-2">{formatNumber(row.rr)}</td>
                    <td className="px-3 py-2">{formatLabel(row.mode)}</td>
                    <td className="px-3 py-2">{row.rejected ? "YES" : "NO"}</td>
                    <td className="px-3 py-2">{row.rejectionReason}</td>
                    <td className="px-3 py-2">{row.nextRequiredAction}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {funnel.triggerDiagnostics.length === 0 ? <p className="py-4 text-center text-sm text-slate-500">No trigger setups yet. Phase 4 is currently the blocker.</p> : null}
          </div>
        </Panel>
      </div>
    </section>
  );
}

export const SignalFunnelPanel = memo(SignalFunnelPanelComponent);

function Metric({ label, value, warn }: { label: string; value: number; warn: boolean }) {
  return (
    <div className="bg-white px-3 py-2">
      <span className="block text-slate-500">{label}</span>
      <strong className={`mt-1 block ${warn ? "text-amber-700" : "text-slate-900"}`}>{value}</strong>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <div className="border border-slate-200"><h3 className="border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase text-slate-700">{title}</h3><div className="p-3">{children}</div></div>;
}

function Value({ label, value }: { label: string; value: string }) {
  return <span><span className="block text-slate-500">{label}</span><strong className="block text-slate-900">{value}</strong></span>;
}

function formatLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "-" : value.toLocaleString("en-US", { maximumFractionDigits: 5 });
}
