// Unit tests for the per-replan revision-log helpers introduced in
// v2.7.2 PR 5: `resolveRevisionReason` (label resolver) and
// `formatPlanHistoryRevisionEntry` (history-detail row formatter).
import { resolveRevisionReason } from '../../packages/shared-domain/src/deadlineLabels';
import { formatPlanHistoryRevisionEntry } from '../../packages/shared-domain/src/deferredPlanHistory';

describe('resolveRevisionReason', () => {
  it('maps prices_revised to "Tomorrow’s prices published"', () => {
    expect(resolveRevisionReason('prices_revised', 'temperature').label).toBe('Tomorrow’s prices published');
  });

  it('maps schedule_revised to "Schedule revised"', () => {
    // Distinct from prices_revised — the recorder emits this when the
    // schedule shifts but no fresher price horizon arrived. UI must not
    // claim a publication event that didn't happen.
    expect(resolveRevisionReason('schedule_revised', 'temperature').label).toBe('Schedule revised');
  });

  it('maps rate_refined to "Rate estimate refined"', () => {
    expect(resolveRevisionReason('rate_refined', 'temperature').label).toBe('Rate estimate refined');
  });

  it('maps objective_changed to "Smart task settings changed"', () => {
    expect(resolveRevisionReason('objective_changed', 'ev_soc').label).toBe('Smart task settings changed');
  });

  it('maps flow_card to "Updated by a Flow card"', () => {
    expect(resolveRevisionReason('flow_card', 'temperature').label).toBe('Updated by a Flow card');
  });

  it('maps prices_arrived to "Prices arrived"', () => {
    expect(resolveRevisionReason('prices_arrived', 'temperature').label).toBe('Prices arrived');
  });

  it('maps device_unavailable to "Device was unreachable"', () => {
    expect(resolveRevisionReason('device_unavailable', 'temperature').label).toBe('Device was unreachable');
  });

  it('maps measured_deviation to "Measured rate differed from plan"', () => {
    expect(resolveRevisionReason('measured_deviation', 'ev_soc').label).toBe('Measured rate differed from plan');
  });

  it('falls back to "Plan refreshed" for an unknown reason code, flagged as a fallback', () => {
    expect(resolveRevisionReason('some_future_reason', 'temperature')).toEqual({
      label: 'Plan refreshed',
      isFallback: true,
    });
  });

  it('falls back to "Plan refreshed" for an empty/null reason id', () => {
    const fallback = { label: 'Plan refreshed', isFallback: true };
    expect(resolveRevisionReason(null, 'temperature')).toEqual(fallback);
    expect(resolveRevisionReason(undefined, 'ev_soc')).toEqual(fallback);
    expect(resolveRevisionReason('', 'temperature')).toEqual(fallback);
  });
});

describe('formatPlanHistoryRevisionEntry', () => {
  // A `Date.UTC` reference time at 12:32 UTC on 16 May 2026. Europe/Oslo is
  // UTC+2 in May (CEST), so this becomes 14:32 local — the timezone test
  // proves the formatter honors the supplied zone instead of falling back
  // to UTC.
  const atMs = Date.UTC(2026, 4, 16, 12, 32, 0);

  it('formats the time in the supplied timezone (Europe/Oslo → 14:32 from 12:32 UTC)', () => {
    const row = formatPlanHistoryRevisionEntry(
      { atMs, reasonId: 'prices_revised', hoursAdded: 2, hoursRemoved: 1 },
      'Europe/Oslo',
      'ev_soc',
    );
    expect(row.timeLabel).toBe('14:32');
    expect(row.reason).toBe('Tomorrow’s prices published');
    expect(row.hourDiff).toBe('+2h −1h');
  });

  it('renders +Nh only when nothing was removed', () => {
    const row = formatPlanHistoryRevisionEntry(
      { atMs, reasonId: 'prices_revised', hoursAdded: 3, hoursRemoved: 0 },
      'UTC',
      'temperature',
    );
    expect(row.hourDiff).toBe('+3h');
  });

  it('renders −Nh only when nothing was added', () => {
    const row = formatPlanHistoryRevisionEntry(
      { atMs, reasonId: 'rate_refined', hoursAdded: 0, hoursRemoved: 2 },
      'UTC',
      'temperature',
    );
    expect(row.hourDiff).toBe('−2h');
  });

  it('suppresses the hour-diff suffix when both add/remove are zero', () => {
    const row = formatPlanHistoryRevisionEntry(
      { atMs, reasonId: 'rate_refined', hoursAdded: 0, hoursRemoved: 0 },
      'UTC',
      'temperature',
    );
    expect(row.hourDiff).toBeNull();
  });

  it('falls back to a placeholder time label when atMs is not a valid timestamp', () => {
    const row = formatPlanHistoryRevisionEntry(
      { atMs: Number.NaN, reasonId: 'prices_revised', hoursAdded: 1, hoursRemoved: 0 },
      'UTC',
      'temperature',
    );
    expect(row.timeLabel).toBe('—');
  });

  it('marks isFallback=false on rows with known reason codes', () => {
    // The history-detail row shape carries the same `isFallback` flag as
    // the live-panel rows so both surfaces can swap in the longer
    // "Plan refreshed (details unavailable)" copy + suppress the diff
    // chip consistently.
    const row = formatPlanHistoryRevisionEntry(
      { atMs, reasonId: 'prices_revised', hoursAdded: 2, hoursRemoved: 1 },
      'UTC',
      'temperature',
    );
    expect(row.isFallback).toBe(false);
  });

  it('marks isFallback=true when the recorder ships an unknown reason code', () => {
    const row = formatPlanHistoryRevisionEntry(
      { atMs, reasonId: 'some_future_reason', hoursAdded: 1, hoursRemoved: 0 },
      'UTC',
      'temperature',
    );
    expect(row.isFallback).toBe(true);
    // Producer label stays terse — the view layer is responsible for
    // swapping in the longer copy when rendering the row.
    expect(row.reason).toBe('Plan refreshed');
  });

  it('marks isFallback=true when the recorder ships an empty/null reason id', () => {
    const rowNull = formatPlanHistoryRevisionEntry(
      { atMs, reasonId: null as never, hoursAdded: 0, hoursRemoved: 0 },
      'UTC',
      'temperature',
    );
    expect(rowNull.isFallback).toBe(true);
  });
});
