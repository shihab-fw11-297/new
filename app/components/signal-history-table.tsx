"use client";

import { memo, useMemo, useState } from "react";
import type { ReactNode } from "react";

import type { Timeframe } from "@/lib/candles/types";
import type { EntryMode, TradeSignal } from "@/lib/entry-engine/types";

type SignalDirectionFilter = "ALL" | "BUY" | "SELL" | "RAPID";
type SignalSortMode = "NEWEST" | "OLDEST" | "HIGHEST_SCORE" | "HIGHEST_RR";

type SignalHistoryTableProps = {
  signals: TradeSignal[];
  symbol: string;
  timeframe: Timeframe;
  selectedSignalId: string | null;
  onSignalSelect: (signal: TradeSignal) => void;
};

function SignalHistoryTableComponent({
  signals,
  symbol,
  timeframe,
  selectedSignalId,
  onSignalSelect,
}: SignalHistoryTableProps) {
  const [directionFilter, setDirectionFilter] = useState<SignalDirectionFilter>("ALL");
  const [modeFilter, setModeFilter] = useState<EntryMode | "ALL">("ALL");
  const [sessionFilter, setSessionFilter] = useState("ALL");
  const [setupFilter, setSetupFilter] = useState("ALL");
  const [dateFilter, setDateFilter] = useState("");
  const [minimumScore, setMinimumScore] = useState("");
  const [minimumRr, setMinimumRr] = useState("");
  const [sortMode, setSortMode] = useState<SignalSortMode>("NEWEST");

  const sessions = useMemo(() => unique(signals.map((signal) => signal.session)), [signals]);
  const setupTypes = useMemo(() => unique(signals.map((signal) => signal.setupType)), [signals]);
  const modes = useMemo(() => unique(signals.map((signal) => signal.mode)), [signals]);

  const filteredSignals = useMemo(() => {
    const minScore = Number(minimumScore);
    const minRr = Number(minimumRr);
    return signals
      .filter((signal) => {
        if (directionFilter === "BUY" && !signal.type.endsWith("BUY")) return false;
        if (directionFilter === "SELL" && !signal.type.endsWith("SELL")) return false;
        if (directionFilter === "RAPID" && !signal.type.startsWith("RAPID")) return false;
        if (modeFilter !== "ALL" && signal.mode !== modeFilter) return false;
        if (sessionFilter !== "ALL" && signal.session !== sessionFilter) return false;
        if (setupFilter !== "ALL" && signal.setupType !== setupFilter) return false;
        if (dateFilter && !new Date(signal.timestamp).toISOString().startsWith(dateFilter)) return false;
        if (Number.isFinite(minScore) && minimumScore !== "" && signal.score < minScore) return false;
        if (Number.isFinite(minRr) && minimumRr !== "" && signal.rr < minRr) return false;
        return true;
      })
      .sort((a, b) => {
        if (sortMode === "OLDEST") return a.timestamp - b.timestamp;
        if (sortMode === "HIGHEST_SCORE") return b.score - a.score || b.timestamp - a.timestamp;
        if (sortMode === "HIGHEST_RR") return b.rr - a.rr || b.timestamp - a.timestamp;
        return b.timestamp - a.timestamp;
      });
  }, [dateFilter, directionFilter, minimumRr, minimumScore, modeFilter, sessionFilter, setupFilter, signals, sortMode]);

  return (
    <section className="border border-slate-200 bg-white">
      <div className="flex flex-col gap-2 border-b border-slate-200 px-4 py-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase text-slate-700">Signal History</h2>
          <p className="mt-1 text-xs text-slate-500">
            {filteredSignals.length} shown / {signals.length} generated
          </p>
        </div>
        <div className="text-xs text-slate-600">
          {symbol} | {timeframe}
        </div>
      </div>

      <div className="grid gap-3 border-b border-slate-200 px-4 py-3 text-xs sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <SelectFilter label="Side" value={directionFilter} onChange={(value) => setDirectionFilter(value as SignalDirectionFilter)} options={["ALL", "BUY", "SELL", "RAPID"]} />
        <SelectFilter label="Mode" value={modeFilter} onChange={(value) => setModeFilter(value as EntryMode | "ALL")} options={["ALL", ...modes]} />
        <SelectFilter label="Session" value={sessionFilter} onChange={setSessionFilter} options={["ALL", ...sessions]} />
        <SelectFilter label="Setup" value={setupFilter} onChange={setSetupFilter} options={["ALL", ...setupTypes]} />
        <label className="flex flex-col gap-1 text-slate-600">
          Date
          <input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} className="h-9 border border-slate-300 px-2 text-xs" />
        </label>
        <label className="flex flex-col gap-1 text-slate-600">
          Min score
          <input type="number" min="0" max="100" value={minimumScore} onChange={(event) => setMinimumScore(event.target.value)} className="h-9 border border-slate-300 px-2 text-xs" />
        </label>
        <label className="flex flex-col gap-1 text-slate-600">
          Min RR
          <input type="number" min="0" step="0.1" value={minimumRr} onChange={(event) => setMinimumRr(event.target.value)} className="h-9 border border-slate-300 px-2 text-xs" />
        </label>
        <SelectFilter label="Sort" value={sortMode} onChange={(value) => setSortMode(value as SignalSortMode)} options={["NEWEST", "OLDEST", "HIGHEST_SCORE", "HIGHEST_RR"]} />
      </div>

      <div className="max-h-[430px] overflow-auto">
        <table className="min-w-[1500px] w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-slate-100 text-slate-600">
            <tr>
              {["Date/time", "Symbol", "Timeframe", "Mode", "Signal type", "Direction", "Entry", "SL", "TP1", "TP2", "TP3", "RR", "Score", "Confidence", "Session", "Setup type", "Strategy model", "Status", "Reason", "Warnings"].map((header) => (
                <th key={header} className="border-b border-slate-200 px-3 py-2 font-semibold">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredSignals.map((signal) => (
              <tr
                key={signal.id}
                onClick={() => onSignalSelect(signal)}
                className={`cursor-pointer transition hover:bg-slate-50 ${selectedSignalId === signal.id ? "bg-cyan-50" : "bg-white"}`}
              >
                <Cell>{formatTime(signal.timestamp)}</Cell>
                <Cell>{symbol}</Cell>
                <Cell>{timeframe}</Cell>
                <Cell>{formatLabel(signal.mode)}</Cell>
                <Cell strong>{formatLabel(signal.type)}</Cell>
                <Cell>{formatLabel(signal.direction)}</Cell>
                <Cell>{formatPrice(signal.entryPrice)}</Cell>
                <Cell>{formatPrice(signal.stopLoss)}</Cell>
                <Cell>{formatPrice(signal.takeProfit)}</Cell>
                <Cell>{formatOptionalPrice(signal.takeProfit2)}</Cell>
                <Cell>{formatOptionalPrice(signal.takeProfit3)}</Cell>
                <Cell strong>{signal.rr.toFixed(2)}R</Cell>
                <Cell>{signal.score}</Cell>
                <Cell>{formatLabel(signal.confidence)}</Cell>
                <Cell>{formatLabel(signal.session)}</Cell>
                <Cell>{formatLabel(signal.setupType)}</Cell>
                <Cell>{signal.strategyModel}</Cell>
                <Cell>{signal.status}</Cell>
                <Cell>{signal.reasons[0] ?? "-"}</Cell>
                <Cell>{signal.warnings.join("; ") || "-"}</Cell>
              </tr>
            ))}
          </tbody>
        </table>
        {filteredSignals.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            No historical signals match the current filters.
          </div>
        ) : null}
      </div>
    </section>
  );
}

export const SignalHistoryTable = memo(SignalHistoryTableComponent);

function SelectFilter({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-slate-600">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 border border-slate-300 bg-white px-2 text-xs">
        {options.map((option) => <option key={option} value={option}>{formatLabel(option)}</option>)}
      </select>
    </label>
  );
}

function Cell({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return <td className={`px-3 py-2 align-top text-slate-700 ${strong ? "font-semibold text-slate-900" : ""}`}>{children}</td>;
}

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 16);
}

function formatLabel(value: string): string {
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatPrice(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 5 });
}

function formatOptionalPrice(value: number | null): string {
  return value === null ? "-" : formatPrice(value);
}
