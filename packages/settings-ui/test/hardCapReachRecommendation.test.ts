import {
  classifyHardCapShortfalls,
  resolveHardCapReachRecommendations,
  type HardCapReachFacts,
} from '../src/ui/hardCapReachRecommendation.ts';

const TZ = 'Europe/Oslo';
// 2026-11-15 18:00 in Oslo.
const NOW = Date.UTC(2026, 10, 15, 17, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const scalars = {
  capacityEnabled: true,
  limitKw: 5,
  marginKw: 0,
  periodMinutes: 60 as const,
  gridImportLimitKw: null,
  dryRun: false,
  followMonthPeak: false,
};

const onDays = (daysBack: readonly number[], overrides: { hardCapKw?: number; uncontrolledW?: number } = {}) => (
  daysBack.map((back) => ({
    atMs: NOW - back * DAY_MS,
    hardCapKw: overrides.hardCapKw ?? 5,
    uncontrolledW: overrides.uncontrolledW ?? 2_700,
  }))
);

const facts = (shortfalls: HardCapReachFacts['shortfalls'], overrides: Partial<typeof scalars> = {}): HardCapReachFacts => ({
  scalars: { ...scalars, ...overrides },
  shortfalls,
});

describe('resolveHardCapReachRecommendations', () => {
  it('says nothing before the facts are read', () => {
    expect(resolveHardCapReachRecommendations(null, NOW, TZ)).toEqual([]);
  });

  it('says nothing for two days, however many incidents', () => {
    const shortfalls = [...onDays([0, 0, 0, 1, 1])];
    expect(resolveHardCapReachRecommendations(facts(shortfalls), NOW, TZ)).toEqual([]);
  });

  it('recommends more controlled load on three days out of seven, never a higher cap', () => {
    const [recommendation] = resolveHardCapReachRecommendations(facts(onDays([0, 0, 2, 5])), NOW, TZ);
    expect(recommendation).toEqual({
      id: 'capacity:hard-cap-out-of-reach',
      version: 5000,
      category: 'recommendation',
      title: 'The 5.0 kW hard cap is often out of reach',
      body: 'On 3 of the last 7 days, PELS had eased off every device it controls and the home was still on '
        + 'pace to exceed the hard cap. Devices PELS does not control drew about 2.7 kW at those times. '
        + 'To stay under it, let PELS control more of the load: add devices, or turn Power-limit control back '
        + 'on for a device.',
      actionLabel: 'Review devices',
      target: { kind: 'panel', panelId: 'devices' },
    });
  });

  it('counts only the last seven local days', () => {
    expect(resolveHardCapReachRecommendations(facts(onDays([0, 3, 7])), NOW, TZ)).toEqual([]);
  });

  it('starts a new record when the owner changes the hard cap', () => {
    const shortfalls = [...onDays([3, 4, 5], { hardCapKw: 4 }), ...onDays([0])];
    expect(resolveHardCapReachRecommendations(facts(shortfalls), NOW, TZ)).toEqual([]);
  });

  it('says nothing while Capacity limit is off', () => {
    expect(resolveHardCapReachRecommendations(facts(onDays([0, 1, 2]), { capacityEnabled: false }), NOW, TZ))
      .toEqual([]);
  });

  it('leaves out the uncontrolled load when there was none', () => {
    const [recommendation] = resolveHardCapReachRecommendations(
      facts(onDays([0, 1, 2], { uncontrolledW: 0 })),
      NOW,
      TZ,
    );
    expect(recommendation?.body).not.toContain('does not control drew');
  });
});

describe('classifyHardCapShortfalls', () => {
  it('drops entries that do not read', () => {
    expect(classifyHardCapShortfalls([
      { atMs: 1, hardCapKw: 5, uncontrolledW: 0 },
      { atMs: 1, hardCapKw: 0, uncontrolledW: 0 },
      { atMs: Number.NaN, hardCapKw: 5, uncontrolledW: 0 },
      'x',
    ])).toEqual([{ atMs: 1, hardCapKw: 5, uncontrolledW: 0 }]);
    expect(classifyHardCapShortfalls(undefined)).toEqual([]);
  });
});
