"use client";

import { memo, useMemo, useState } from "react";

import type { MarketSetup, SetupScannerResult, SetupState, SetupType } from "@/lib/setup-scanner/types";

type DirectionFilter = "ALL" | "BULLISH" | "BEARISH";
type StateFilter = "ACTIVE" | "ALL" | "INVALIDATED" | "EXPIRED";

const TYPES: Array<{ value: "ALL" | SetupType; label: string }> = [
  { value: "ALL", label: "All setup types" },
  { value: "LIQUIDITY_SWEEP_REVERSAL", label: "Liquidity sweep reversal" },
  { value: "TREND_CONTINUATION", label: "Trend continuation" },
  { value: "COMPRESSION_BREAKOUT", label: "Compression breakout" },
  { value: "RANGE_REVERSAL", label: "Range reversal" },
];

function SetupScannerPanelComponent({
  result,
  replayEnabled,
  overlaysVisible,
  onOverlaysVisibleChange,
}: {
  result: SetupScannerResult;
  replayEnabled: boolean;
  overlaysVisible: boolean;
  onOverlaysVisibleChange: (visible: boolean) => void;
}) {
  const [direction, setDirection] = useState<DirectionFilter>("ALL");
  const [state, setState] = useState<StateFilter>("ACTIVE");
  const [type, setType] = useState<"ALL" | SetupType>("ALL");
  const [strongOnly, setStrongOnly] = useState(false);
  const filtered = useMemo(() => result.setups.filter((setup) => {
    if (direction !== "ALL" && setup.direction !== direction) return false;
    if (state === "ACTIVE" && (setup.state === "INVALIDATED" || setup.state === "EXPIRED")) return false;
    if (state === "INVALIDATED" && setup.state !== "INVALIDATED") return false;
    if (state === "EXPIRED" && setup.state !== "EXPIRED") return false;
    if (type !== "ALL" && setup.type !== type) return false;
    if (strongOnly && setup.score < 75) return false;
    return true;
  }), [direction, result.setups, state, strongOnly, type]);

  return (
    <section className="border border-slate-200 bg-white" aria-label="Setup Scanner Panel">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase text-slate-700">Setup Scanner</h2>
          <p className="mt-1 text-xs font-medium text-amber-800">
            Phase 4 setups are not trade entries. Final BUY/SELL comes in Phase 5.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={overlaysVisible} onChange={(event) => onOverlaysVisibleChange(event.target.checked)} />
          Setup chart overlays
        </label>
      </div>

      <div className="grid gap-3 border-b border-slate-200 p-4 md:grid-cols-[auto_auto_minmax(180px,1fr)_auto] md:items-center">
        <div className="flex h-9 border border-slate-300" aria-label="Direction filter">
          {(["ALL", "BULLISH", "BEARISH"] as DirectionFilter[]).map((item) => (
            <button key={item} type="button" onClick={() => setDirection(item)} className={`px-3 text-xs font-semibold ${direction === item ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
              {item === "ALL" ? "All" : formatLabel(item)}
            </button>
          ))}
        </div>
        <select value={state} onChange={(event) => setState(event.target.value as StateFilter)} className="h-9 border border-slate-300 bg-white px-2 text-sm text-slate-700" aria-label="Setup state filter">
          <option value="ACTIVE">Active WATCH / SETUP / TRIGGER</option>
          <option value="ALL">All states</option>
          <option value="INVALIDATED">Invalidated</option>
          <option value="EXPIRED">Expired</option>
        </select>
        <select value={type} onChange={(event) => setType(event.target.value as "ALL" | SetupType)} className="h-9 border border-slate-300 bg-white px-2 text-sm text-slate-700" aria-label="Setup type filter">
          {TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <label className="flex items-center gap-2 whitespace-nowrap text-sm text-slate-700">
          <input type="checkbox" checked={strongOnly} onChange={(event) => setStrongOnly(event.target.checked)} />
          Strong only (75+)
        </label>
      </div>

      <div className="grid grid-cols-2 divide-x divide-y divide-slate-200 border-b border-slate-200 sm:grid-cols-5 sm:divide-y-0">
        <Counter label="WATCH" value={result.audit.watchCount} />
        <Counter label="SETUP" value={result.audit.setupCount} />
        <Counter label="TRIGGER" value={result.audit.triggerCount} />
        <Counter label="INVALIDATED" value={result.audit.invalidatedCount} />
        <Counter label="EXPIRED" value={result.audit.expiredCount} />
      </div>

      {filtered.length ? (
        <div className="grid gap-3 p-4 lg:grid-cols-2">
          {filtered.map((setup) => <SetupCard key={setup.id} setup={setup} />)}
        </div>
      ) : (
        <p className="px-4 py-6 text-sm text-slate-500">No setups match the current filters. The scanner continues evaluating closed candles.</p>
      )}

      <div className="grid gap-x-6 gap-y-1 border-t border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600 sm:grid-cols-4">
        <span>Current candle index: {result.audit.currentCandleIndex}</span>
        <span>Active setups: {result.audit.activeSetupCount}</span>
        <span>State transitions: {result.audit.transitionCount}</span>
        <span>No-future validation: {result.audit.noFutureValidation}</span>
        {replayEnabled ? <span className="font-semibold text-cyan-800 sm:col-span-4">Replay debug is active; scanner evidence is limited to this candle.</span> : null}
      </div>
    </section>
  );
}

export const SetupScannerPanel = memo(SetupScannerPanelComponent);

function SetupCard({ setup }: { setup: MarketSetup }) {
  return (
    <article className={`border p-3 ${stateClass(setup.state)}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-900">{formatLabel(setup.type)}</p>
          <p className="mt-1 text-xs text-slate-500">Created {formatTime(setup.createdAt)} | {setup.sourceTimeframe}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={directionClass(setup.direction)}>{formatLabel(setup.direction)}</span>
          <span className={badgeClass(setup.state)}>{setup.state}</span>
          <span className="font-mono text-sm font-bold text-slate-900">{setup.score}</span>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-[108px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-slate-500">Liquidity</dt><dd className="truncate text-slate-800">{setup.relatedLiquidity ? `${setup.relatedLiquidity.type} ${formatPrice(setup.relatedLiquidity.price)}` : "Contextual level"}</dd>
        <dt className="text-slate-500">Sweep</dt><dd className="truncate text-slate-800">{setup.relatedSweep?.type ?? "Not confirmed"}</dd>
        <dt className="text-slate-500">Structure</dt><dd className="truncate text-slate-800">{setup.relatedStructure ? `${setup.relatedStructure.type} ${setup.relatedStructure.direction}` : "Not confirmed"}</dd>
        <dt className="text-slate-500">Setup zone</dt><dd className="text-slate-800">{formatLabel(setup.setupZone.type)} {formatPrice(setup.setupZone.minPrice)} - {formatPrice(setup.setupZone.maxPrice)}</dd>
        <dt className="text-slate-500">Invalidation</dt><dd className="text-slate-800">{formatPrice(setup.invalidationLevel.price)} ({formatLabel(setup.invalidationLevel.source)})</dd>
        <dt className="text-slate-500">Target liquidity</dt><dd className="text-slate-800">{setup.targetLiquidity ? `${formatLabel(setup.targetLiquidity.targetType)} ${formatPrice(setup.targetLiquidity.price)}` : "No clean target"}</dd>
      </dl>

      <p className="mt-3 border-t border-current/10 pt-2 text-xs text-slate-700">{setup.reasons.at(-1)}</p>
      {setup.warnings.length ? <p className="mt-2 text-xs text-amber-800">Warning: {setup.warnings[0]}</p> : null}
      {setup.failedReasons.length ? <p className="mt-2 text-xs font-medium text-red-800">{setup.failedReasons.at(-1)}</p> : null}
      {setup.history.length ? (
        <details className="mt-2 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium">State history ({setup.history.length})</summary>
          <ol className="mt-1 space-y-1 border-l border-slate-300 pl-2">
            {setup.history.map((item) => <li key={`${item.timestamp}-${item.to}`}>{item.from} to {item.to} at candle {item.candleIndex}: {item.reason}</li>)}
          </ol>
        </details>
      ) : null}
    </article>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return <div className="px-3 py-2 text-center"><div className="font-mono text-lg font-semibold text-slate-900">{value}</div><div className="text-[10px] font-semibold text-slate-500">{label}</div></div>;
}

function stateClass(state: SetupState): string {
  if (state === "TRIGGER") return "border-emerald-500 bg-emerald-50";
  if (state === "SETUP") return "border-cyan-400 bg-cyan-50/40";
  if (state === "INVALIDATED") return "border-red-300 bg-red-50/50 opacity-70";
  if (state === "EXPIRED") return "border-slate-300 bg-slate-100 opacity-65";
  return "border-dashed border-amber-400 bg-amber-50/30";
}

function badgeClass(state: SetupState): string {
  const colors: Record<SetupState, string> = { WATCH: "border-amber-400 text-amber-800", SETUP: "border-cyan-500 text-cyan-800", TRIGGER: "border-emerald-500 bg-emerald-600 text-white", INVALIDATED: "border-red-400 text-red-800", EXPIRED: "border-slate-400 text-slate-600" };
  return `border px-1.5 py-0.5 text-[10px] font-bold ${colors[state]}`;
}

function directionClass(direction: MarketSetup["direction"]): string {
  return `text-[10px] font-bold ${direction === "BULLISH" ? "text-emerald-700" : direction === "BEARISH" ? "text-red-700" : "text-slate-600"}`;
}

function formatLabel(value: string): string {
  return value.toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 5 }).format(value);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 16);
}
