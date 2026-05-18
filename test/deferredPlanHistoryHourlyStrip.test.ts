// Unit tests for the smart-task history-detail per-hour bar strip resolver
// (v2.7.3). Producer-resolves the postmortem "when did each hour run, and
// what did each hour cost?" surface — every conditional (cheap-hour glow,
// planned-but-skipped outline, kWh fallback) is flattened here so the view
// layer never branches on the entry shape.
import { resolveHistoryDetailHourlyStrip } from '../packages/shared-domain/src/deferredPlanHistory';
import type {
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryHourlyContribution,
} from '../packages/contracts/src/deferredObjectivePlanHistory';

const HOUR_MS = 60 * 60 * 1000;
const DEADLINE_MS = Date.UTC(2026, 4, 17, 8, 0, 0); // Sun 17 May 08:00 UTC
const START_MS = DEADLINE_MS - 4 * HOUR_MS; // 4-hour run

const buildEntry = (
  overrides: Partial<DeferredObjectivePlanHistoryEntry> = {},
): DeferredObjectivePlanHistoryEntry => ({
  id: 'entry-1',
  deviceId: 'dev-1',
  deviceName: 'Tesla',
  objectiveKind: 'ev_soc',
  targetTemperatureC: null,
  targetPercent: 80,
  deadlineAtMs: DEADLINE_MS,
  startedAtMs: START_MS,
  finalizedAtMs: DEADLINE_MS,
  startProgressC: null,
  startProgressPercent: 40,
  finalProgressC: null,
  finalProgressPercent: 80,
  initialEnergyNeededKWh: 15,
  outcome: 'met',
  metAtMs: DEADLINE_MS - HOUR_MS,
  usedDeadlineReserve: false,
  usedPolicyAvoid: false,
  observedIntervals: [],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
  ...overrides,
});

describe('resolveHistoryDetailHourlyStrip', () => {
  it('returns absent when the entry carries neither contributions nor planned hours', () => {
    const entry = buildEntry();
    const data = resolveHistoryDetailHourlyStrip(entry);
    expect(data.mode).toBe('absent');
  });

  it('returns absent for legacy v4 entries that have planned hours but no hourlyContributions', () => {
    // Production = v2.7.1, but v4 entries from a v2.7.2 beta channel may
    // exist on Homey installs with `originalPlan` set and no
    // `hourlyContributions`. Rendering an all-outlined strip for those
    // would falsely imply PELS skipped every hour. The postmortem strip
    // has no honest answer without delivery data — suppress it.
    const entry = buildEntry({
      originalPlan: {
        hours: [{ startsAtMs: START_MS, plannedKWh: 2.0 }],
        energyNeededKWh: 2,
        planStatus: 'on_track',
        revisedAtMs: START_MS,
      },
    });
    const data = resolveHistoryDetailHourlyStrip(entry);
    expect(data.mode).toBe('absent');
  });

  it('produces one bucket per hour in [startedAtMs, deadlineAtMs] from contributions', () => {
    const hourlyContributions: DeferredObjectivePlanHistoryHourlyContribution[] = [
      { atMs: START_MS, deliveredKWh: 2.4, priceValue: 0.15, tone: 'cheap' },
      { atMs: START_MS + HOUR_MS, deliveredKWh: 3.6, priceValue: 0.45, tone: 'normal' },
      { atMs: START_MS + 2 * HOUR_MS, deliveredKWh: 1.2, priceValue: 0.95, tone: 'expensive' },
    ];
    const entry = buildEntry({ hourlyContributions });
    const data = resolveHistoryDetailHourlyStrip(entry);
    if (data.mode !== 'present') throw new Error('expected present');
    expect(data.buckets).toHaveLength(4);
    expect(data.buckets[0]!.atMs).toBe(START_MS);
    expect(data.buckets[0]!.kwh).toBeCloseTo(2.4);
    expect(data.buckets[0]!.tone).toBe('cheap');
    expect(data.buckets[0]!.delivered).toBe(true);
    expect(data.buckets[0]!.outlinePresent).toBe(false);
    expect(data.buckets[3]!.delivered).toBe(false);
    expect(data.buckets[3]!.kwh).toBe(0);
  });

  it('marks only the lowest-priced cheap delivered hour with the cheapest highlight', () => {
    const hourlyContributions: DeferredObjectivePlanHistoryHourlyContribution[] = [
      // Two cheap hours: the second one is cheaper.
      { atMs: START_MS, deliveredKWh: 1.0, priceValue: 0.20, tone: 'cheap' },
      { atMs: START_MS + HOUR_MS, deliveredKWh: 1.5, priceValue: 0.12, tone: 'cheap' },
      // A normal-tone hour with an even lower price is ignored — the highlight
      // is reserved for the tier the design synthesis calls out.
      { atMs: START_MS + 2 * HOUR_MS, deliveredKWh: 2.0, priceValue: 0.05, tone: 'normal' },
    ];
    const entry = buildEntry({ hourlyContributions });
    const data = resolveHistoryDetailHourlyStrip(entry);
    if (data.mode !== 'present') throw new Error('expected present');
    const highlighted = data.buckets.filter((bucket) => bucket.cheapestDeliveredHighlight);
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]!.atMs).toBe(START_MS + HOUR_MS);
  });

  it('renders planned-but-not-delivered hours as outlined buckets with zero bar height fallback', () => {
    const entry = buildEntry({
      originalPlan: {
        hours: [
          { startsAtMs: START_MS, plannedKWh: 2.0 },
          { startsAtMs: START_MS + HOUR_MS, plannedKWh: 2.0 },
        ],
        energyNeededKWh: 4,
        planStatus: 'on_track',
        revisedAtMs: START_MS,
      },
      finalPlan: null,
      hourlyContributions: [
        { atMs: START_MS, deliveredKWh: 2.0, priceValue: 0.30, tone: 'cheap' },
      ],
    });
    const data = resolveHistoryDetailHourlyStrip(entry);
    if (data.mode !== 'present') throw new Error('expected present');
    // First hour: planned + delivered.
    expect(data.buckets[0]!.planned).toBe(true);
    expect(data.buckets[0]!.delivered).toBe(true);
    expect(data.buckets[0]!.outlinePresent).toBe(false);
    // Second hour: planned, not delivered → outlined.
    expect(data.buckets[1]!.planned).toBe(true);
    expect(data.buckets[1]!.delivered).toBe(false);
    expect(data.buckets[1]!.outlinePresent).toBe(true);
    expect(data.buckets[1]!.kwh).toBe(2.0); // Falls back to plannedKWh for tooltip context.
  });

  it('suppresses the cheapest highlight when no cheap hour was delivered', () => {
    const hourlyContributions: DeferredObjectivePlanHistoryHourlyContribution[] = [
      // A cheap hour with zero delivered → not "actually charged in".
      { atMs: START_MS, deliveredKWh: 0, priceValue: 0.10, tone: 'cheap' },
      { atMs: START_MS + HOUR_MS, deliveredKWh: 1.5, priceValue: 0.60, tone: 'normal' },
    ];
    const entry = buildEntry({ hourlyContributions });
    const data = resolveHistoryDetailHourlyStrip(entry);
    if (data.mode !== 'present') throw new Error('expected present');
    expect(data.buckets.some((bucket) => bucket.cheapestDeliveredHighlight)).toBe(false);
  });
});
