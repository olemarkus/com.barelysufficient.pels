// Usage-tab Solar card orchestrator (weatherInsight mount pattern): resolves
// every card prop from the power-tracker payload + cached prices, then hands
// them to the Preact view (`views/SolarUsageCard.tsx`). Hooked from
// `power.ts` on each stats render.
//
// Visibility gate (PR-5 spec resolution 3): a home with a tracked solar
// device always sees the card; otherwise any recorded generation shows it,
// and export alone must clear the 7-day materiality floor so one
// junk-negative net sample never conjures the card. When the gate fails the
// mount stays structurally empty.

import type { PowerTrackerState } from '../../../contracts/src/powerTrackerTypes.ts';
import { hasRecordedAnyExport } from '../../../shared-domain/src/solar/exhibitedExport.ts';
import { resolveSolarMoneyToday } from '../../../shared-domain/src/solar/solarMoney.ts';
import { normalizeCombinedPrices } from './combinedPrices.ts';
import { formatCost } from './dailyBudgetCost.ts';
import { getPricesReadModel } from './prices.ts';
import { resolveCostDisplayFromCombinedPrices } from './priceUnit.ts';
import {
  buildSolarDayRows,
  buildTodaySolarHourMaps,
  resolveSolarCardVisible,
  type SolarDayRow,
} from './solarStats.ts';
import { formatDayFirstInTimeZone, getDateKeyInTimeZone, getDateKeyStartMs } from './timezone.ts';
import {
  renderSolarUsageCard,
  type SolarHistoryRow,
  type SolarMoneyBlock,
  type SolarUsageCardProps,
} from './views/SolarUsageCard.tsx';

const asRecord = (value: unknown): Record<string, number> | undefined => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, number>
    : undefined
);

// Appended INLINE to a money value (registered rule in notes/ui-terminology.md
// § Solar) — never rendered as a standalone line, which would open a sentence
// with a bare middot.
const UNPRICED_HOURS_SUFFIX = ' · some hours unpriced';

const formatMoneyValue = (minor: number, combined: unknown, someHoursUnpriced: boolean): string => (
  `≈ ${formatCost(minor, resolveCostDisplayFromCombinedPrices(combined))}`
  + (someHoursUnpriced ? UNPRICED_HOURS_SUFFIX : '')
);

const resolveMoneyBlock = (params: {
  combined: unknown;
  layout: 'full' | 'export-only';
  generationBuckets?: Record<string, number>;
  exportBuckets?: Record<string, number>;
  timeZone: string;
  todayKey: string;
}): SolarMoneyBlock | null => {
  const { combined, layout, generationBuckets, exportBuckets, timeZone, todayKey } = params;
  // Blank-unit price schemes (Flow/Homey payloads without a usable unit)
  // degrade to kWh-only — the same gate the Budget money view uses, so a bare
  // unit-less money number is never shown.
  if (resolveCostDisplayFromCombinedPrices(combined).unit.trim() === '') return null;
  const priceRows = normalizeCombinedPrices(combined);
  if (priceRows.length === 0) return null;
  const money = resolveSolarMoneyToday({
    priceRows,
    ...buildTodaySolarHourMaps({ generationBuckets, exportBuckets, timeZone, todayKey }),
  });
  // Each line carries its own coverage suffix: import-price coverage flags the
  // avoided line, export-price coverage flags the earned line (they are
  // independent axes — see resolveSolarMoneyToday).
  if (layout === 'export-only') {
    // Without measured production, "grid cost avoided" is always zero — noise.
    // Show earnings when an export price exists, otherwise just the nudge to
    // configure one (import prices prove the scheme carries money).
    if (money.earnedMinor !== null) {
      return {
        avoidedValueText: null,
        earnedValueText: formatMoneyValue(money.earnedMinor, combined, money.unpricedExportHours > 0),
        showExportPriceHint: false,
      };
    }
    return money.avoidedMinor !== null
      ? {
        avoidedValueText: null,
        earnedValueText: null,
        showExportPriceHint: true,
      }
      : null;
  }
  if (money.avoidedMinor === null) return null;
  return {
    avoidedValueText: formatMoneyValue(money.avoidedMinor, combined, money.unpricedSolarHours > 0),
    earnedValueText: money.earnedMinor !== null
      ? formatMoneyValue(money.earnedMinor, combined, money.unpricedExportHours > 0)
      : null,
    showExportPriceHint: money.earnedMinor === null,
  };
};

const toHistoryRow = (row: SolarDayRow, timeZone: string): SolarHistoryRow => ({
  ...row,
  label: formatDayFirstInTimeZone(
    new Date(getDateKeyStartMs(row.dateKey, timeZone)),
    { weekday: 'short', day: 'numeric', month: 'short' },
    timeZone,
  ),
});

const hasGenerationEvidence = (
  generationBuckets: Record<string, number> | undefined,
  rows: readonly SolarDayRow[],
): boolean => (
  rows.some((row) => row.generatedKWh > 0)
  || Object.values(generationBuckets ?? {}).some((value) => typeof value === 'number' && value > 0)
);

const readCombinedPrices = async (): Promise<unknown> => {
  // Prices are a bonus tier — a failed fetch degrades the card to kWh-only
  // rather than blocking it.
  try {
    return (await getPricesReadModel()).combinedPrices ?? null;
  } catch {
    return null;
  }
};

export const resolveSolarUsageCardProps = (params: {
  tracker: PowerTrackerState | null;
  combined: unknown;
  timeZone: string;
  todayKey: string;
  hasManagedSolarDevice: boolean;
}): SolarUsageCardProps | null => {
  const { tracker, combined, timeZone, todayKey, hasManagedSolarDevice } = params;
  const generationBuckets = asRecord(tracker?.generationBuckets);
  const exportBuckets = asRecord(tracker?.exportBuckets);
  const rows = buildSolarDayRows({ generationBuckets, exportBuckets, timeZone, todayKey });
  if (!resolveSolarCardVisible({ hasManagedSolarDevice, generationBuckets, rows })) return null;
  if (rows.length === 0) {
    // Gate passed but the displayed 7-day window has no data — a tracked-solar
    // home with no accounting yet, or one whose solar history is all older
    // than the window.
    return {
      layout: 'gathering',
      today: null,
      history: [],
      money: null,
      showBatteryExportNote: false,
      showNoExportMeasuredNote: false,
    };
  }
  const layout = hasGenerationEvidence(generationBuckets, rows) ? 'full' : 'export-only';
  const today = rows.find((row) => row.dateKey === todayKey) ?? null;
  const history = rows
    .filter((row) => row.dateKey !== todayKey)
    .map((row) => toHistoryRow(row, timeZone));
  return {
    layout,
    today,
    history,
    money: resolveMoneyBlock({ combined, layout, generationBuckets, exportBuckets, timeZone, todayKey }),
    // Only meaningful when production IS measured (full layout): in a battery
    // home an odd hour/day can honestly export more than the panels produced —
    // including a pure-battery-export day where production is zero.
    showBatteryExportNote: layout === 'full'
      && rows.some((row) => row.exportedKWh > row.generatedKWh),
    // Only where the claim is actually being made: the full layout is the one
    // that renders "Used at home · 100%" and prices it. An export-only home has
    // export by definition, and the gathering tier asserts nothing yet.
    // ANY recorded export clears the note: a single negative sample proves the
    // home's net can express export, which is the only thing the note is about.
    // Shared with the runtime posture gate, so the card and the surplus engine
    // agree on what counts as evidence.
    showNoExportMeasuredNote: layout === 'full' && !hasRecordedAnyExport(tracker),
  };
};

// Below this, the hero's "+ … of your own solar" supplement is noise (mirrors
// the self-use-rate materiality floor in solarStats).
const HERO_SUPPLEMENT_MIN_KWH = 0.05;

export type SolarUsageSectionResult = {
  /**
   * Today's self-consumed kWh when the card shows measured production, for
   * the usage hero's reconciliation line — `null` when the card is hidden,
   * gathering, export-only (self-use unknown), or immaterial.
   */
  todaySelfUsedKWh: number | null;
};

/** Usage-tab render hook — called from `power.ts` on each stats render. */
export const renderSolarUsageSection = async (params: {
  tracker: PowerTrackerState | null;
  timeZone: string;
  /** Home-level solar signal from the /ui_power payload (absence = false). */
  hasManagedSolarDevice: boolean;
  /**
   * Staleness gate owned by the caller's refresh pass (`refreshPowerData`'s run
   * generation). This section awaits its OWN read (prices) after the caller's
   * last check, so the caller cannot fence it from outside: by the time control
   * returns, the card is already painted. A home whose prices settle after a
   * newer scope pick has painted would overwrite just the solar card and then
   * fail the caller's post-await check — a persistent mixed-home panel, one
   * home's solar under another's hero. Required, not defaulted: every path into
   * this section must name the run it belongs to.
   */
  isCurrentRun: () => boolean;
}): Promise<SolarUsageSectionResult> => {
  const mount = document.getElementById('solar-usage-mount');
  if (!mount) return { todaySelfUsedKWh: null };
  const { tracker, timeZone, hasManagedSolarDevice, isCurrentRun } = params;
  const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
  const combined = await readCombinedPrices();
  // Fence BEFORE the mutation, not after: this is the last statement that can
  // still drop a superseded run without having touched the DOM.
  if (!isCurrentRun()) return { todaySelfUsedKWh: null };
  const props = resolveSolarUsageCardProps({
    tracker,
    combined,
    timeZone,
    todayKey,
    hasManagedSolarDevice,
  });
  renderSolarUsageCard(mount, props);
  const todaySelfUsedKWh = props?.layout === 'full' && props.today !== null
    && props.today.selfUsedKWh > HERO_SUPPLEMENT_MIN_KWH
    ? props.today.selfUsedKWh
    : null;
  return { todaySelfUsedKWh };
};
