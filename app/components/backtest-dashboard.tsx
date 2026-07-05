"use client";

import { memo } from "react";
import type { ReactNode } from "react";

import type { BacktestResult, BacktestSettings, BacktestTrade } from "@/lib/backtesting/types";
import type { SetupType } from "@/lib/setup-scanner/types";
import type { TradingSession } from "@/lib/market-context/types";

type BacktestDashboardProps = {
  result: BacktestResult;
  settings: BacktestSettings;
  hydrated: boolean;
  selectedTradeId: string | null;
  onSettingsChange: (settings: BacktestSettings) => void;
  onTradeSelect: (trade: BacktestTrade) => void;
};

const SESSIONS: Array<TradingSession | "ALL"> = ["ALL", "ASIAN", "LONDON", "NEW_YORK", "LONDON_NEW_YORK_OVERLAP", "DEAD_ZONE"];
const SETUP_TYPES: Array<SetupType | "ALL"> = ["ALL", "LIQUIDITY_SWEEP_REVERSAL", "TREND_CONTINUATION", "COMPRESSION_BREAKOUT", "RANGE_REVERSAL"];

function BacktestDashboardComponent({
  result,
  settings,
  hydrated,
  selectedTradeId,
  onSettingsChange,
  onTradeSelect,
}: BacktestDashboardProps) {
  const metrics = result.metrics;

  return (
    <section className="border border-slate-200 bg-white">
      <div className="flex flex-col gap-2 border-b border-slate-200 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase text-slate-700">Backtest Dashboard</h2>
          <p className="mt-1 text-xs text-slate-500">Phase 7 strategy calibration and historical proof</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <ExportButton label="Trade CSV" filename="trade-journal.csv" content={result.exports.tradeJournalCsv} mime="text/csv" />
          <ExportButton label="Rejected CSV" filename="rejected-setups.csv" content={result.exports.rejectedSetupsCsv} mime="text/csv" />
          <ExportButton label="JSON report" filename="backtest-report.json" content={result.exports.jsonReport} mime="application/json" />
        </div>
      </div>

      <div className="grid gap-3 border-b border-slate-200 px-4 py-3 text-xs sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        <NumberInput label="Balance" value={settings.accountBalance} min={100} step={100} onChange={(value) => onSettingsChange({ ...settings, accountBalance: value })} />
        <NumberInput label="Risk %" value={settings.riskPerTradePercent} min={0.1} step={0.1} onChange={(value) => onSettingsChange({ ...settings, riskPerTradePercent: value })} />
        <NumberInput label="Max trades/day" value={settings.maxTradesPerDay} min={1} step={1} onChange={(value) => onSettingsChange({ ...settings, maxTradesPerDay: value })} />
        <NumberInput label="Daily loss %" value={settings.maxDailyLossPercent} min={0.1} step={0.1} onChange={(value) => onSettingsChange({ ...settings, maxDailyLossPercent: value })} />
        <NumberInput label="Spread pts" value={settings.spreadPoints} min={0} step={0.01} onChange={(value) => onSettingsChange({ ...settings, spreadPoints: value })} />
        <NumberInput label="Slippage pts" value={settings.slippagePoints} min={0} step={0.01} onChange={(value) => onSettingsChange({ ...settings, slippagePoints: value })} />
        <NumberInput label="Commission" value={settings.commissionPerLot} min={0} step={1} onChange={(value) => onSettingsChange({ ...settings, commissionPerLot: value })} />
        <NumberInput label="Max candles held" value={settings.maxHoldingCandles} min={1} step={1} onChange={(value) => onSettingsChange({ ...settings, maxHoldingCandles: value })} />
        <SelectInput label="Same candle" value={settings.sameCandlePolicy} options={["CONSERVATIVE_SL_FIRST", "OPTIMISTIC_TP_FIRST", "MARK_UNKNOWN"]} onChange={(value) => onSettingsChange({ ...settings, sameCandlePolicy: value as BacktestSettings["sameCandlePolicy"] })} />
        <SelectInput label="Session" value={settings.sessionFilter} options={SESSIONS} onChange={(value) => onSettingsChange({ ...settings, sessionFilter: value as BacktestSettings["sessionFilter"] })} />
        <SelectInput label="Setup type" value={settings.setupTypeFilter} options={SETUP_TYPES} onChange={(value) => onSettingsChange({ ...settings, setupTypeFilter: value as BacktestSettings["setupTypeFilter"] })} />
        <Toggle label="Breakeven" checked={settings.enableBreakeven} onChange={(value) => onSettingsChange({ ...settings, enableBreakeven: value })} />
        <Toggle label="Partials" checked={settings.enablePartials} onChange={(value) => onSettingsChange({ ...settings, enablePartials: value })} />
        <Toggle label="Trailing" checked={settings.enableTrailing} onChange={(value) => onSettingsChange({ ...settings, enableTrailing: value })} />
      </div>

      <div className="grid grid-cols-2 gap-px bg-slate-200 text-xs md:grid-cols-3 xl:grid-cols-6">
        <Metric label="Total trades" value={metrics.totalTrades} />
        <Metric label="Win rate" value={`${metrics.winRate.toFixed(2)}%`} />
        <Metric label="Profit factor" value={formatFinite(metrics.profitFactor)} />
        <Metric label="Expectancy" value={`${metrics.expectancy.toFixed(3)}R`} />
        <Metric label="Total R" value={`${metrics.totalR.toFixed(2)}R`} />
        <Metric label="Max drawdown" value={formatCurrency(metrics.maxDrawdown)} />
        <Metric label="Net PnL" value={formatCurrency(metrics.netPnl)} />
        <Metric label="Avg win R" value={metrics.averageWinR.toFixed(2)} />
        <Metric label="Avg loss R" value={metrics.averageLossR.toFixed(2)} />
        <Metric label="Avg MFE" value={metrics.averageMfe.toFixed(2)} />
        <Metric label="Avg MAE" value={metrics.averageMae.toFixed(2)} />
        <Metric label="Calc ms" value={hydrated ? result.audit.calculationTimeMs.toFixed(2) : "-"} />
      </div>

      <div className="grid gap-4 border-t border-slate-200 p-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Panel title="Equity Curve">
          <EquityCurve result={result} />
        </Panel>
        <Panel title="Prop Firm Simulation">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Value label="Status" value={result.propFirm.passed ? "PASSED" : "FAILED"} strong />
            <Value label="Fail reason" value={result.propFirm.failReason ?? "-"} />
            <Value label="Daily DD hit" value={result.propFirm.dailyDrawdownHit ? "YES" : "NO"} />
            <Value label="Total DD hit" value={result.propFirm.totalDrawdownHit ? "YES" : "NO"} />
            <Value label="Profit target" value={result.propFirm.profitTargetHit ? "YES" : "NO"} />
            <Value label="Trading days" value={String(result.propFirm.tradingDaysCount)} />
            <Value label="Best day concentration" value={`${result.propFirm.bestDayProfitConcentration.toFixed(2)}%`} />
          </div>
        </Panel>
      </div>

      <div className="grid gap-4 px-4 pb-4 xl:grid-cols-2">
        <Panel title="Trade List">
          <div className="max-h-[360px] overflow-auto">
            <table className="min-w-[1180px] w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-100 text-slate-600">
                <tr>
                  {["Date", "Signal", "Setup", "Entry", "SL", "TP", "Result", "Final R", "PnL", "Session", "Reason"].map((item) => <th key={item} className="px-3 py-2 font-semibold">{item}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.trades.map((trade) => (
                  <tr key={trade.tradeId} onClick={() => onTradeSelect(trade)} className={`cursor-pointer hover:bg-slate-50 ${selectedTradeId === trade.tradeId ? "bg-cyan-50" : ""}`}>
                    <td className="px-3 py-2">{formatTime(trade.entryTime)}</td>
                    <td className="px-3 py-2">{trade.direction === "BULLISH" ? "BUY" : "SELL"}</td>
                    <td className="px-3 py-2">{formatLabel(trade.setupType)}</td>
                    <td className="px-3 py-2">{formatPrice(trade.entryPrice)}</td>
                    <td className="px-3 py-2">{formatPrice(trade.stopLoss)}</td>
                    <td className="px-3 py-2">{formatPrice(trade.takeProfit)}</td>
                    <td className="px-3 py-2 font-semibold">{formatLabel(trade.result)}</td>
                    <td className="px-3 py-2">{trade.finalR.toFixed(2)}</td>
                    <td className="px-3 py-2">{formatCurrency(trade.pnl)}</td>
                    <td className="px-3 py-2">{formatLabel(trade.session)}</td>
                    <td className="px-3 py-2">{trade.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {result.trades.length === 0 ? <p className="px-3 py-6 text-center text-sm font-semibold text-amber-700">No trades found. Backtest cannot calculate win rate. Check Signal Funnel.</p> : null}
          </div>
        </Panel>

        <Panel title="Rejection Analysis">
          <p className="text-xs text-slate-600">{result.rejectionAnalytics.notes[0]}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Value label="Setups scanned" value={String(result.rejectionAnalytics.totalSetupsScanned)} />
            <Value label="Triggers rejected" value={String(result.rejectionAnalytics.triggerCount)} />
            <Value label="Confirmed signals" value={String(result.rejectionAnalytics.confirmedSignalCount)} />
            <Value label="Rejected signals" value={String(result.rejectionAnalytics.rejectedSignalCount)} />
            <Value label="Rejected would win" value={String(result.rejectionAnalytics.rejectedButLaterWouldHaveWonCount)} />
            <Value label="Avoided losses" value={String(result.rejectionAnalytics.rejectedAndCorrectlyAvoidedLossCount)} />
          </div>
          <MiniTable rows={result.rejectionAnalytics.rejectionHistogram.slice(0, 8).map((item) => [item.reason, String(item.count)])} empty="No rejected setups." />
        </Panel>
      </div>

      <div className="grid gap-4 px-4 pb-4 xl:grid-cols-2">
        <Panel title="Breakdowns">
          <BreakdownTable title="Session" rows={result.breakdowns.bySession} />
          <BreakdownTable title="Setup type" rows={result.breakdowns.bySetupType} />
          <BreakdownTable title="Direction" rows={result.breakdowns.byDirection} />
          <BreakdownTable title="Regime" rows={result.breakdowns.byMarketRegime} />
          <BreakdownTable title="Score bucket" rows={result.breakdowns.byScoreBucket} />
          <BreakdownTable title="RR bucket" rows={result.breakdowns.byRrBucket} />
          <BreakdownTable title="Time of day" rows={result.breakdowns.byHour} />
        </Panel>
        <Panel title="Calibration and Robustness">
          <div className="overflow-auto">
            <table className="min-w-[760px] w-full text-left text-xs">
              <thead className="bg-slate-100 text-slate-600">
                <tr>{["Setting", "Trades", "Win rate", "PF", "Expectancy", "Max DD", "Total R", "Notes"].map((item) => <th key={item} className="px-3 py-2 font-semibold">{item}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.calibration.map((item) => (
                  <tr key={item.settingName}>
                    <td className="px-3 py-2">{formatLabel(item.settingName)}</td>
                    <td className="px-3 py-2">{item.totalTrades}</td>
                    <td className="px-3 py-2">{item.winRate.toFixed(2)}%</td>
                    <td className="px-3 py-2">{formatFinite(item.profitFactor)}</td>
                    <td className="px-3 py-2">{item.expectancy.toFixed(3)}</td>
                    <td className="px-3 py-2">{formatCurrency(item.maxDrawdown)}</td>
                    <td className="px-3 py-2">{item.totalR.toFixed(2)}</td>
                    <td className="px-3 py-2">{item.notes[0]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Value label="Worst-case drawdown" value={formatCurrency(result.robustness.worstCaseDrawdown)} />
            <Value label="Average stress outcome" value={`${result.robustness.averageOutcome.toFixed(2)}R`} />
            <Value label="Losing streak risk" value={`${result.robustness.probabilityOfLosingStreak.toFixed(2)}%`} />
            <Value label="Risk warning" value={result.robustness.riskOfRuinWarning ?? "None"} />
          </div>
          <p className="mt-3 text-xs font-semibold text-amber-700">Best historical settings may overfit and fail live.</p>
        </Panel>
      </div>

      <div className="border-t border-slate-200 px-4 py-3">
        <p className="text-xs font-semibold text-slate-700">Screenshot-ready summary</p>
        <p className="mt-1 text-xs text-slate-600">{result.exports.summaryText}</p>
      </div>
    </section>
  );
}

export const BacktestDashboard = memo(BacktestDashboardComponent);

function NumberInput({ label, value, min, step, onChange }: { label: string; value: number; min: number; step: number; onChange: (value: number) => void }) {
  return (
    <label className="flex flex-col gap-1 text-slate-600">
      {label}
      <input type="number" min={min} step={step} value={value} onChange={(event) => onChange(Math.max(min, Number(event.target.value) || min))} className="h-9 border border-slate-300 px-2 text-xs" />
    </label>
  );
}

function SelectInput({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-slate-600">
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} className="h-9 border border-slate-300 bg-white px-2 text-xs">
        {options.map((option) => <option key={option} value={option}>{formatLabel(option)}</option>)}
      </select>
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-center gap-2 self-end pb-2 text-xs text-slate-700"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function ExportButton({ label, filename, content, mime }: { label: string; filename: string; content: string; mime: string }) {
  return (
    <button type="button" onClick={() => download(filename, content, mime)} className="border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50">
      {label}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="bg-white px-3 py-2"><span className="block text-slate-500">{label}</span><strong className="mt-1 block text-slate-900">{value}</strong></div>;
}

function Value({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return <span><span className="block text-slate-500">{label}</span><strong className={`block ${strong ? "text-slate-950" : "text-slate-800"}`}>{value}</strong></span>;
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <div className="border border-slate-200"><h3 className="border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase text-slate-700">{title}</h3><div className="p-3">{children}</div></div>;
}

function EquityCurve({ result }: { result: BacktestResult }) {
  if (result.equityCurve.length === 0) return <p className="text-sm text-slate-500">No equity curve until trades are available.</p>;
  const values = result.equityCurve.map((point) => point.balance);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  return (
    <div className="flex h-40 items-end gap-1 border-b border-l border-slate-200 px-2">
      {result.equityCurve.map((point) => (
        <div key={`${point.timestamp}:${point.balance}`} title={`${formatTime(point.timestamp)} ${formatCurrency(point.balance)}`} className="min-w-1 flex-1 bg-cyan-600" style={{ height: `${Math.max(4, ((point.balance - min) / range) * 130 + 4)}px` }} />
      ))}
    </div>
  );
}

function MiniTable({ rows, empty }: { rows: string[][]; empty: string }) {
  if (rows.length === 0) return <p className="mt-3 text-xs text-slate-500">{empty}</p>;
  return <table className="mt-3 w-full text-left text-xs"><tbody>{rows.map((row) => <tr key={row.join(":")} className="border-t border-slate-100"><td className="py-1 pr-2 text-slate-600">{row[0]}</td><td className="py-1 text-right font-semibold">{row[1]}</td></tr>)}</tbody></table>;
}

function BreakdownTable({ title, rows }: { title: string; rows: Array<{ key: string; totalTrades: number; winRate: number; profitFactor: number; expectancy: number; totalR: number }> }) {
  return (
    <div className="mb-4 last:mb-0">
      <p className="text-xs font-semibold text-slate-800">{title}</p>
      <MiniTable rows={rows.slice(0, 6).map((row) => [formatLabel(row.key), `${row.totalTrades} | ${row.winRate.toFixed(1)}% | ${formatFinite(row.profitFactor)} PF | ${row.totalR.toFixed(1)}R`])} empty={`No ${title.toLowerCase()} breakdown yet.`} />
    </div>
  );
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
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

function formatCurrency(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function formatFinite(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "INF";
}
