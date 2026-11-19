import type { SettingsUiPowerPayload } from '../../contracts/src/settingsUi/power.ts';
import {
  checkHardCap,
  checkInstantLimit,
  formatHardCapFinding,
  formatInstantLimitFinding,
  resolveLimitUsageEvidence,
} from '../src/ui/limitUsageGuard.ts';

const HOUR = 3_600_000;
// 2026-11-16 12:30 UTC; Oslo is UTC+1.
const NOW = Date.parse('2026-11-16T12:30:00Z');
const hourIso = (hoursAgo: number) => new Date(Math.floor(NOW / HOUR) * HOUR - hoursAgo * HOUR).toISOString();

const payload = (
  kwByHoursAgo: (hoursAgo: number) => number,
  hours: number,
  extra: Partial<SettingsUiPowerPayload['tracker']> = {},
  lastPowerW = 2000,
  lastUpdateAgoMs = 10_000,
): SettingsUiPowerPayload => {
  const buckets: Record<string, number> = {};
  for (let ago = 1; ago <= hours; ago += 1) buckets[hourIso(ago)] = kwByHoursAgo(ago);
  buckets[hourIso(0)] = 0.1; // the current, partial hour
  return {
    tracker: { buckets, lastPowerW, ...extra },
    readings: { state: 'received', lastPowerUpdateMs: NOW - lastUpdateAgoMs },
  } as unknown as SettingsUiPowerPayload;
};

describe('limit usage evidence', () => {
  it('reads complete hours of the last 7 days and the current reading', () => {
    const evidence = resolveLimitUsageEvidence(payload(() => 1, 200), NOW);
    expect(evidence.hours).toHaveLength(168);
    expect(evidence.current?.kw).toBe(2);
  });

  it('compares only the current reading with under a day of history', () => {
    const evidence = resolveLimitUsageEvidence(payload(() => 5, 20), NOW);
    expect(evidence.hours).toEqual([]);
    expect(checkInstantLimit(1.5, evidence, NOW)).toMatchObject({ kind: 'current', currentKw: 2, targetKw: 1.5 });
  });

  it('a newer readings heartbeat cannot refresh the age of cached watts', () => {
    const evidence = resolveLimitUsageEvidence(payload(() => 0, 0, { lastTimestamp: NOW - HOUR }), NOW);
    expect(checkInstantLimit(1, evidence, NOW)).toBeNull();
  });

  it('ignores a stale reading and hours in an unreliable period', () => {
    const spike = Date.parse(hourIso(5));
    const evidence = resolveLimitUsageEvidence(
      payload((ago) => (ago === 5 ? 9 : 1), 48, { unreliablePeriods: [{ start: spike, end: spike + HOUR }] }, 2000, 600_000),
      NOW,
    );
    expect(evidence.current).toBeNull();
    expect(checkInstantLimit(3, evidence, NOW)).toBeNull();
  });
});

describe('instant limits', () => {
  it('names the highest hour above the limit and how many hours were', () => {
    const evidence = resolveLimitUsageEvidence(payload((ago) => (ago === 20 ? 4.6 : ago % 10 === 0 ? 3.5 : 1), 48), NOW);
    const finding = checkInstantLimit(3, evidence, NOW);
    expect(finding).toMatchObject({ kind: 'past_hours', hoursAbove: 4, peak: { kw: 4.6 } });
    expect(formatInstantLimitFinding(finding!, NOW, 'Europe/Oslo')).toBe(
      'Your home averaged 4.6 kW from 17:00 to 18:00 yesterday, above the 3.0 kW where PELS starts reducing loads. '
      + 'The hourly average exceeded that target in 4 hours over the last 7 days.',
    );
  });

  it('labels yesterday by the local calendar after a short day', () => {
    const finding = {
      kind: 'past_hours' as const, hoursAbove: 1, targetKw: 3,
      peak: { startMs: Date.parse('2026-03-29T12:00:00+02:00'), kw: 4 },
    };
    expect(formatInstantLimitFinding(finding, Date.parse('2026-03-30T00:30:00+02:00'), 'Europe/Oslo'))
      .toContain('yesterday');
  });

  it('says nothing when the home stayed under the limit', () => {
    const evidence = resolveLimitUsageEvidence(payload(() => 1, 48), NOW);
    expect(checkInstantLimit(3, evidence, NOW)).toBeNull();
  });
});

describe('hard cap', () => {
  it('does not warn for a cap below past peaks', () => {
    const evidence = resolveLimitUsageEvidence(payload((ago) => (ago % 4 === 0 ? 6 : 0.5), 168), NOW);
    expect(checkHardCap(3, evidence, NOW)).toBeNull();
  });

  it('ages the accepted hourly history out of both warnings during a prolonged outage', () => {
    const evidence = resolveLimitUsageEvidence(payload(() => 5, 48), NOW);
    const later = NOW + 7 * 24 * HOUR;
    expect(checkHardCap(1, evidence, later)).toBeNull();
    expect(checkInstantLimit(1, evidence, later)).toBeNull();
  });

  it('warns for a cap below what the home uses in nine hours out of ten', () => {
    const evidence = resolveLimitUsageEvidence(payload(() => 1.2, 168), NOW);
    const finding = checkHardCap(1, evidence, NOW);
    expect(finding).toEqual({ baseLoadKw: 1.2, targetKw: 1 });
    expect(formatHardCapFinding(finding!)).toContain('at least 1.2 kW');
  });
});
