import type { MarketContextResult } from "@/lib/market-context/types";

export function MarketContextDashboard({
  context,
  cacheStatusLabel,
}: {
  context: MarketContextResult;
  cacheStatusLabel: string;
}) {
  const pd = context.premiumDiscount;
  return (
    <section>
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase text-slate-700">Phase 3 Market Context</h2>
          <p className="mt-1 text-xs font-medium text-amber-800">
            Phase 3 is market context only. It does not create BUY/SELL entries.
          </p>
        </div>
        <span className="text-xs text-slate-500">Context cache: {cacheStatusLabel}</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <ContextCard title="Timeframe Mapping" rows={[
          ["Mode", context.mapping.modeName], ["LTF", context.mapping.ltf], ["ITF", context.mapping.itf], ["HTF", context.mapping.htf],
        ]} />
        <ContextCard title="HTF Bias" rows={[
          ["Bias", context.htfBias.bias], ["Strength", `${context.htfBias.strength}/100`], ["Structure", context.htfBias.structureState],
          ["Major high", price(context.htfBias.majorSwingHigh)], ["Major low", price(context.htfBias.majorSwingLow)],
          ["Last BOS", context.htfBias.lastBos ?? "-"], ["Last CHOCH", context.htfBias.lastChoch ?? "-"],
        ]} reason={context.htfBias.reason} />
        <ContextCard title="ITF Setup Environment" rows={[
          ["State", label(context.itfSetup.setupState)], ["Direction", context.itfSetup.direction], ["Strength", `${context.itfSetup.strength}/100`],
          ["Sweep", context.itfSetup.relatedSweep ?? "-"], ["Displacement", context.itfSetup.relatedDisplacement ?? "-"], ["Structure", context.itfSetup.relatedStructure ?? "-"],
          ["Pullback zone", context.itfSetup.pullbackZone ? `${price(context.itfSetup.pullbackZone.minPrice)} - ${price(context.itfSetup.pullbackZone.maxPrice)}` : "-"],
        ]} reason={context.itfSetup.reason} />
        <ContextCard title="Premium / Discount" rows={[
          ["Range high", price(pd?.rangeHigh ?? null)], ["Range low", price(pd?.rangeLow ?? null)], ["Equilibrium", price(pd?.equilibrium ?? null)],
          ["Current zone", pd ? label(pd.zone) : "Unknown"], ["Location", pd ? `${pd.currentPositionPercent.toFixed(1)}%` : "-"],
          ["Bullish quality", pd ? `${pd.buyQuality}/100` : "-"], ["Bearish quality", pd ? `${pd.sellQuality}/100` : "-"],
        ]} reason={pd?.reason} />
        <ContextCard title="Market Regime" rows={[
          ["Regime", label(context.regime.regime)], ["Confidence", `${context.regime.confidence}/100`], ["Trend quality", `${context.regime.trendQuality}/100`],
          ["Range quality", `${context.regime.rangeQuality}/100`], ["Chop risk", `${context.regime.chopRisk}/100`],
        ]} reason={context.regime.reason} />
        <ContextCard title="Session" rows={[
          ["Active", label(context.session.session)], ["Quality", `${context.session.sessionQuality}/100`], ["Bias", context.session.sessionBias],
          ["Display timezone", context.session.displayTimezone], ["Session open", time(context.session.sessionOpen, context.session.displayTimezone)],
          ["Session close", time(context.session.sessionClose, context.session.displayTimezone)],
          ["Current high", price(context.session.currentSessionHigh)], ["Current low", price(context.session.currentSessionLow)],
          ["Previous high", price(context.session.previousSessionHigh)], ["Previous low", price(context.session.previousSessionLow)],
        ]} reason={context.session.reason} />
        <ContextCard title="Volatility" rows={[
          ["State", label(context.volatility.state)], ["ATR", price(context.volatility.atr)], ["ATR percentile", `${context.volatility.atrPercentile}%`],
          ["Average range", price(context.volatility.averageRange)], ["Expansion", `${context.volatility.expansionRatio.toFixed(2)}x`],
        ]} reason={context.volatility.warning ?? context.volatility.reason} />
        <ContextCard title="Context Score" rows={[
          ["Overall", `${context.score.overallScore}/100`], ["Preference", context.score.directionPreference], ["Environment", context.score.tradeEnvironment],
          ["Wait", context.wait.shouldWait ? "YES" : "NO"],
        ]} reason={context.wait.waitReasons.length ? `WAIT: ${context.wait.waitReasons.join(" ")} Need: ${context.wait.requiredForImprovement.join(" ")}` : context.score.reason} />
      </div>
    </section>
  );
}

function ContextCard({ title, rows, reason }: { title: string; rows: Array<[string, string]>; reason?: string }) {
  return (
    <article className="border border-slate-200 bg-white">
      <h3 className="border-b border-slate-200 px-3 py-2.5 text-xs font-semibold uppercase text-slate-700">{title}</h3>
      <dl className="divide-y divide-slate-100">
        {rows.map(([name, value]) => (
          <div key={name} className="grid grid-cols-[1fr_auto] gap-2 px-3 py-2 text-xs">
            <dt className="text-slate-500">{name}</dt>
            <dd className="max-w-[170px] truncate text-right font-medium text-slate-900" title={value}>{value}</dd>
          </div>
        ))}
      </dl>
      {reason ? <p className="border-t border-slate-100 px-3 py-2.5 text-xs leading-5 text-slate-600">{reason}</p> : null}
    </article>
  );
}

function label(value: string): string {
  return value.toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function price(value: number | null): string {
  return value === null ? "-" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 5 }).format(value);
}

function time(value: number | null, timeZone: string): string {
  if (value === null) {
    return "-";
  }

  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(value);
}
