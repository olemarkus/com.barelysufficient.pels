import { render } from 'preact';
import { MdElevation } from './materialWebJSX.tsx';
import type { SolarDayRow } from '../solarStats.ts';

// Usage-tab Solar card (PR-5 solar visibility). All data is producer-resolved
// in `solarUsageSection.ts`; this view only renders. Copy is card-local by
// design (no runtime log shares these strings — see the PR-5 spec, judge
// resolution 4). Vocabulary registered in `notes/ui-terminology.md` § Solar.

const CARD_TITLE = 'Solar';
const SUBTITLE_TODAY = 'Today so far';
const SUBTITLE_EXPORT_ONLY = 'Exported energy today';
const LABEL_PRODUCED = 'Produced';
const LABEL_USED_AT_HOME = 'Used at home';
const LABEL_EXPORTED = 'Exported';
// Money labels carry "today" — the block sits below the today metrics but
// above "Previous days", so the scope must be explicit on the labels
// themselves (registered rule: money is today-only in v1).
const LABEL_AVOIDED = 'Grid cost avoided today';
const LABEL_EARNED = 'Earned from export today';
const HISTORY_TITLE = 'Previous days';
// Compact column headers for the previous-days grid (registered short forms
// of Produced / Used at home / Exported).
const COLUMN_DAY = 'Day';
const COLUMN_PRODUCED = 'Produced';
const COLUMN_AT_HOME = 'At home';
const COLUMN_EXPORTED = 'Exported';
const EXPORT_PRICE_HINT = 'Add an export price under Settings → Electricity prices to see export earnings.';
const GATHERING_BODY = 'Watching your solar production. Numbers appear after the first hour with sun.';
const EXPORT_ONLY_NOTE = 'Your meter reports export only — production is not measured.';
const BATTERY_EXPORT_NOTE = 'Exported can be higher than produced when a battery sends stored power to the grid.';

export type SolarMoneyBlock = {
  /** "≈ 12.40 kr" (optionally "… · some hours unpriced") — null hides the avoided line. */
  avoidedValueText: string | null;
  /** "≈ 3.10 kr" (signed, optionally suffixed) — null hides the earned line. */
  earnedValueText: string | null;
  /** Show the "add an export price" nudge (avoided-only tier). */
  showExportPriceHint: boolean;
};

export type SolarHistoryRow = SolarDayRow & {
  /** Pre-formatted local-day label, e.g. "Mon 29 Jun". */
  label: string;
};

export type SolarUsageCardProps = {
  layout: 'full' | 'export-only' | 'gathering';
  /** Today's totals so far; null renders zeros (a real solar home before sunrise). */
  today: SolarDayRow | null;
  /** Previous days in the 7-day window, newest first (today excluded). */
  history: SolarHistoryRow[];
  /** null = kWh-only tier (no prices, or a blank-unit price scheme). */
  money: SolarMoneyBlock | null;
  /** Some displayed day exported more than it produced (battery home). */
  showBatteryExportNote: boolean;
};

const formatKWh = (kWh: number): string => `${kWh.toFixed(1)} kWh`;

const formatRate = (rate: number | null): string | null => (
  rate === null ? null : `${Math.round(rate * 100)}%`
);

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div class="usage-metric">
    <span class="usage-metric__label metric-label">{label}</span>
    <span class="usage-metric__value">{value}</span>
  </div>
);

const TodayMetrics = ({ layout, today }: { layout: 'full' | 'export-only'; today: SolarDayRow | null }) => {
  const generatedKWh = today?.generatedKWh ?? 0;
  const exportedKWh = today?.exportedKWh ?? 0;
  const selfUsedKWh = today?.selfUsedKWh ?? 0;
  const rateText = formatRate(today?.selfUseRate ?? null);
  if (layout === 'export-only') {
    return (
      <div class="usage-metric-row">
        <Metric label={LABEL_EXPORTED} value={formatKWh(exportedKWh)} />
      </div>
    );
  }
  return (
    <div class="usage-metric-row">
      <Metric label={LABEL_PRODUCED} value={formatKWh(generatedKWh)} />
      <Metric
        label={LABEL_USED_AT_HOME}
        value={rateText !== null ? `${formatKWh(selfUsedKWh)} · ${rateText}` : formatKWh(selfUsedKWh)}
      />
      <Metric label={LABEL_EXPORTED} value={formatKWh(exportedKWh)} />
    </div>
  );
};

const MoneyBlock = ({ money }: { money: SolarMoneyBlock }) => (
  <div class="solar-money" id="solar-usage-money">
    {money.avoidedValueText !== null && (
      <div class="solar-money__line">
        <span class="solar-money__label">{LABEL_AVOIDED}</span>
        <span class="solar-money__value">{money.avoidedValueText}</span>
      </div>
    )}
    {money.earnedValueText !== null && (
      <div class="solar-money__line">
        <span class="solar-money__label">{LABEL_EARNED}</span>
        <span class="solar-money__value">{money.earnedValueText}</span>
      </div>
    )}
    {money.showExportPriceHint && <p class="pels-card-supporting solar-money__note">{EXPORT_PRICE_HINT}</p>}
  </div>
);

// Previous-days grid: columns are labelled ONCE by a compact header row (the
// `.metric-label` caption role, like the sibling usage cards' stat labels);
// data cells then carry bare values so the row grid can shrink to 320 px
// without min-content prose blowing the card out of the panel.
const HistoryRows = ({ layout, history }: { layout: 'full' | 'export-only'; history: SolarHistoryRow[] }) => {
  if (history.length === 0) return null;
  const rowClass = layout === 'export-only' ? 'solar-day-row solar-day-row--export-only' : 'solar-day-row';
  return (
    <div class="solar-days" id="solar-usage-history">
      <p class="pels-card-supporting solar-days__title">{HISTORY_TITLE}</p>
      <div class={rowClass} aria-hidden="true">
        <span class="metric-label">{COLUMN_DAY}</span>
        {layout === 'full' && <span class="metric-label solar-day-row__header-cell">{COLUMN_PRODUCED}</span>}
        {layout === 'full' && <span class="metric-label solar-day-row__header-cell">{COLUMN_AT_HOME}</span>}
        <span class="metric-label solar-day-row__header-cell">{COLUMN_EXPORTED}</span>
      </div>
      {history.map((row) => (
        <div key={row.dateKey} class={rowClass}>
          <span class="solar-day-row__day">{row.label}</span>
          {layout === 'full' && <span class="solar-day-row__value">{formatKWh(row.generatedKWh)}</span>}
          {layout === 'full' && (
            <span class="solar-day-row__value">{formatRate(row.selfUseRate) ?? '—'}</span>
          )}
          <span class="solar-day-row__value">{formatKWh(row.exportedKWh)}</span>
        </div>
      ))}
    </div>
  );
};

export const SolarUsageCard = ({ layout, today, history, money, showBatteryExportNote }: SolarUsageCardProps) => (
  <section class="pels-surface-card usage-card" id="solar-usage-card" aria-labelledby="solar-usage-title">
    <MdElevation aria-hidden="true" />
    <div class="usage-card__header">
      <div class="usage-card__heading">
        <h3 class="plan-card__title" id="solar-usage-title">{CARD_TITLE}</h3>
        {layout !== 'gathering' && (
          <p class="pels-card-supporting">
            {layout === 'export-only' ? SUBTITLE_EXPORT_ONLY : SUBTITLE_TODAY}
          </p>
        )}
      </div>
    </div>
    {layout === 'gathering' ? (
      <p class="pels-card-supporting" id="solar-usage-gathering">{GATHERING_BODY}</p>
    ) : (
      <>
        <TodayMetrics layout={layout} today={today} />
        {money !== null && <MoneyBlock money={money} />}
        <HistoryRows layout={layout} history={history} />
        {layout === 'export-only' && <p class="pels-card-supporting">{EXPORT_ONLY_NOTE}</p>}
        {showBatteryExportNote && <p class="pels-card-supporting">{BATTERY_EXPORT_NOTE}</p>}
      </>
    )}
  </section>
);

/** Thin mount wrapper for the non-Preact orchestrator; `null` clears the mount. */
export const renderSolarUsageCard = (mount: HTMLElement, props: SolarUsageCardProps | null): void => {
  render(props === null ? null : <SolarUsageCard {...props} />, mount);
};
