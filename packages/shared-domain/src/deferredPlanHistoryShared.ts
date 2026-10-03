import type { DeferredObjectiveSettingsKind } from '../../contracts/src/deferredObjectiveSettings';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
} from '../../contracts/src/deferredObjectivePlanHistory';
import { formatTimeInTimeZone } from './utils/dateUtils';

// Internal helpers shared between `deferredPlanHistory.ts` (the public entry)
// and `deferredPlanHistoryPostmortem.ts` (the postmortem resolvers extracted to
// keep each file under the 500-effective-line ESLint cap). Kept in a sibling so
// neither consumer has to import the other — that would create a dependency
// cycle (the public entry re-exports the postmortem symbols).

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;

// Overshoot threshold matches the `notes/smart-task-ui/README.md` design spec
// ("Notable extras: overshoot line if delivered > target by > 5 °C / 10 %").
// Shared by `formatPlanHistoryOvershootLine` (the dedicated overshoot line) and
// `wasOvershoot` (the postmortem detector) so the two can't drift on the
// threshold definition (5 °C / 10 %).
export const OVERSHOOT_TEMPERATURE_THRESHOLD_C_PUBLIC = 5;
export const OVERSHOOT_PERCENT_THRESHOLD_PUBLIC = 10;
// An energy task stands the device down at its target, so the energy fed runs
// over only by the draw between two lifecycle ticks; a kWh past that is worth
// a line.
export const OVERSHOOT_ENERGY_THRESHOLD_KWH_PUBLIC = 1;

export const OVERSHOOT_THRESHOLD_BY_KIND: Record<DeferredObjectiveSettingsKind, number> = {
  temperature: OVERSHOOT_TEMPERATURE_THRESHOLD_C_PUBLIC,
  ev_soc: OVERSHOOT_PERCENT_THRESHOLD_PUBLIC,
  energy: OVERSHOOT_ENERGY_THRESHOLD_KWH_PUBLIC,
};

/**
 * A history value in its task's unit: "65.0 °C", "80 %", "9.2 kWh". The one
 * place the history surfaces pick a precision and a suffix per kind.
 */
export const formatHistoryValueForKind = (
  kind: DeferredObjectiveSettingsKind,
  value: number,
): string => {
  switch (kind) {
    case 'temperature': return `${value.toFixed(1)} °C`;
    case 'ev_soc': return `${value.toFixed(0)} %`;
    case 'energy': return `${value.toFixed(1)} kWh`;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

export const formatClockTime = (ms: number, timeZone: string): string | null => {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return formatTimeInTimeZone(date, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }, timeZone);
};

export const pickLastPlan = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'finalPlan' | 'originalPlan'>,
): DeferredObjectivePlanHistoryRevisionSnapshot | null => (
  // Prefer the final plan's status — it reflects the planner's last word
  // before finalization. Fall back to the original snapshot when the run
  // finalized before the planner replanned (no finalPlan recorded).
  entry.finalPlan ?? entry.originalPlan
);

// One scheduled hour as the history readers and the run-band producer
// (`resolveRunBands`, live plans included) read it. `coversFromMs` only comes
// from a revision's hours. A booking covers its whole hour; for the run's first
// hour the run-band producer clamps that to the window start.
export type ScheduledHistoryHour = Pick<
  DeferredObjectivePlanHistoryRevisionSnapshot['hours'][number],
  'startsAtMs' | 'plannedKWh' | 'coversFromMs'
>;

/**
 * The hours a finished run had scheduled, with what each booked: the per-hour
 * answer the chart's run bands, the receipt's largest planned hour and the
 * logged planned total read. The hourly strip reads the same record.
 *
 * It is a per-hour view, not the run's need. A `:58` re-plan books an
 * under-delivered hour's shortfall into later hours, so a sum over these hours
 * counts that energy again; compare delivery against `initialEnergyExpectedKWh`.
 *
 * The source is each hour's booking at its start (`hourStartBookings`). The
 * final revision cannot answer this: every hourly re-plan drops the hours that
 * have elapsed, so by the end it holds only what was still ahead, and the
 * current hour's booking has shrunk to its remainder — an overnight charging
 * run read back as one hour of 0.03 kWh. Hours the plan in force booked
 * nothing for stay in the list at zero; callers count only positive bookings.
 *
 * An entry without the record (finalized before it shipped, or a run that
 * never had a plan) falls back to the hours of the planner's last word
 * (`pickLastPlan`), today's reading for those entries. `null` means no plan was
 * recorded at all.
 */
export const pickScheduledHours = (
  entry: Pick<DeferredObjectivePlanHistoryEntry, 'hourStartBookings' | 'finalPlan' | 'originalPlan'>,
): readonly ScheduledHistoryHour[] | null => {
  if (entry.hourStartBookings !== undefined) {
    return entry.hourStartBookings.map((booking) => ({ startsAtMs: booking.atMs, plannedKWh: booking.bookedKWh }));
  }
  return pickLastPlan(entry)?.hours ?? null;
};

// Sum of the positive bookings in a schedule (see `pickScheduledHours`). With
// hour-start bookings this includes energy re-booked after a short hour.
export const sumScheduledKWh = (hours: readonly ScheduledHistoryHour[]): number => {
  let total = 0;
  for (const hour of hours) {
    if (Number.isFinite(hour.plannedKWh) && hour.plannedKWh > 0) total += hour.plannedKWh;
  }
  return total;
};
