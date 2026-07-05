import type { CandleReadingResult } from "@/lib/candle-reading/types";

export function CandleReadingPanel({
  reading,
}: {
  reading: CandleReadingResult | null;
}) {
  if (!reading) {
    return (
      <aside className="border border-slate-200 bg-white p-4">
        <PanelHeading />
        <p className="mt-3 text-sm text-slate-500">
          At least two closed candles are needed for scenario analysis.
        </p>
      </aside>
    );
  }

  const latest = reading.latestCandle;
  const rows: Array<[string, string]> = [
    ["Last candle", formatEnum(latest.primaryType)],
    ["Last candle strength", `${reading.scores.latestCandle.total}/10 ${reading.scores.latestCandle.label}`],
    ["Pressure", formatEnum(reading.sequence.pressure)],
    ["Sequence mood", formatEnum(reading.marketMood)],
    ["Momentum", formatEnum(reading.sequence.momentumState)],
    ["Volatility", formatEnum(reading.sequence.volatilityState)],
    ["Expected bias", formatEnum(reading.scenarios.expectedBias)],
    ["Reversal risk", formatEnum(reading.reversalWarning.reversalRisk)],
    ["Confidence", `${reading.scores.confidence.score}/10 ${reading.scores.confidence.label}`],
  ];

  return (
    <aside className="border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <PanelHeading />
        <p className="mt-1 text-xs font-medium text-amber-800">
          This is scenario analysis, not a trade signal.
        </p>
      </div>

      <dl className="divide-y divide-slate-100">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[1fr_auto] gap-3 px-4 py-2.5 text-sm"
          >
            <dt className="text-slate-500">{label}</dt>
            <dd className="max-w-[190px] text-right font-medium text-slate-900">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="border-t border-slate-200 px-4 py-4">
        <h3 className="text-xs font-semibold uppercase text-slate-600">
          Trader Read
        </h3>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          {reading.humanSummary}
        </p>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          {reading.sequence.reason}
        </p>
      </div>

      <div className="border-t border-slate-200 px-4 py-4">
        <h3 className="text-xs font-semibold uppercase text-slate-600">
          Conditional Next Candle Paths
        </h3>
        <ScenarioRow
          label="Bullish"
          probability={reading.scenarios.bullishScenario.probability}
          condition={reading.scenarios.bullishScenario.condition}
          behavior={reading.scenarios.bullishScenario.expectedBehavior}
          invalidation={reading.scenarios.bullishScenario.invalidation}
          color="text-emerald-700"
        />
        <ScenarioRow
          label="Bearish"
          probability={reading.scenarios.bearishScenario.probability}
          condition={reading.scenarios.bearishScenario.condition}
          behavior={reading.scenarios.bearishScenario.expectedBehavior}
          invalidation={reading.scenarios.bearishScenario.invalidation}
          color="text-red-700"
        />
        <ScenarioRow
          label="Neutral / range"
          probability={reading.scenarios.neutralScenario.probability}
          condition={reading.scenarios.neutralScenario.condition}
          behavior={reading.scenarios.neutralScenario.expectedBehavior}
          invalidation={reading.scenarios.neutralScenario.invalidation}
          color="text-slate-700"
        />
        <p className="mt-3 border-l-2 border-amber-400 pl-3 text-xs leading-5 text-slate-600">
          {reading.scenarios.warning}
        </p>
      </div>

      <div className="border-t border-slate-200 px-4 py-4">
        <h3 className="text-xs font-semibold uppercase text-slate-600">
          Why This Read May Fail
        </h3>
        {reading.reversalWarning.reasons.length > 0 ? (
          <ul className="mt-2 space-y-1.5 text-xs leading-5 text-slate-600">
            {reading.reversalWarning.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs leading-5 text-slate-600">
            Unexpected news, session liquidity, spread changes, or a close beyond
            the stated invalidation can overturn the current read.
          </p>
        )}
      </div>

      <div className="border-t border-slate-200 px-4 py-4">
        <h3 className="text-xs font-semibold uppercase text-slate-600">
          Key Levels
        </h3>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <Level label="Previous high" value={reading.keyLevels.previousHigh} />
          <Level label="Previous low" value={reading.keyLevels.previousLow} />
          <Level label="Previous midpoint" value={reading.keyLevels.previousMidpoint} />
          <Level label="Latest close" value={reading.keyLevels.latestClose} />
        </dl>
      </div>

      <details className="border-t border-slate-200 px-4 py-4">
        <summary className="cursor-pointer text-xs font-semibold uppercase text-slate-600">
          Trader Questions
        </summary>
        <ul className="mt-3 space-y-2 text-xs leading-5 text-slate-600">
          {Object.values(reading.questions).map((answer) => (
            <li key={answer}>{answer}</li>
          ))}
        </ul>
      </details>

      <details className="border-t border-slate-200 px-4 py-4">
        <summary className="cursor-pointer text-xs font-semibold uppercase text-slate-600">
          Candle-by-candle read ({reading.analyzedCandleCount})
        </summary>
        <ol className="mt-3 space-y-3 text-xs leading-5 text-slate-600">
          {reading.candles.map((candle) => (
            <li key={candle.timestamp}>
              <span className="font-semibold text-slate-800">
                {formatEnum(candle.primaryType)}:
              </span>{" "}
              {candle.explanation}
            </li>
          ))}
        </ol>
      </details>
    </aside>
  );
}

function PanelHeading() {
  return (
    <h2 className="text-sm font-semibold uppercase tracking-normal text-slate-700">
      Candle Reading
    </h2>
  );
}

function ScenarioRow({
  label,
  probability,
  condition,
  behavior,
  invalidation,
  color,
}: {
  label: string;
  probability: number;
  condition: string;
  behavior: string;
  invalidation: number;
  color: string;
}) {
  return (
    <div className="border-b border-slate-100 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3 text-sm font-semibold">
        <span className={color}>{label}</span>
        <span className="tabular-nums text-slate-900">{probability}%</span>
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-600">{condition}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{behavior}</p>
      <p className="mt-1 text-xs text-slate-500">
        Invalidation: {formatPrice(invalidation)}
      </p>
    </div>
  );
}

function Level({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums text-slate-900">
        {formatPrice(value)}
      </dd>
    </div>
  );
}

function formatEnum(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 5 }).format(value);
}
