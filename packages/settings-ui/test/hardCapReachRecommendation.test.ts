import { getPowerReadModel } from '../src/ui/power.ts';
import type { SettingsUiPowerPayload } from '../../contracts/src/settingsUi/power.ts';
import {
  classifyHardCapShortfalls,
  loadHardCapReachFacts,
  readHardCapReachFacts,
  readHardCapReachStatus,
  resolveHardCapReachRecommendations,
  type HardCapReachFacts,
} from '../src/ui/hardCapReachRecommendation.ts';

vi.mock('../src/ui/power.ts', () => ({ getPowerReadModel: vi.fn() }));

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
      body: 'On 3 of the last 7 days, the home was on pace to exceed the hard cap and PELS had nothing '
        + 'left it could turn down. Devices PELS does not control drew about 2.7 kW at those times. '
        + 'To stay under it, let PELS control more of the load: add devices, or turn Power-limit control back '
        + 'on for a device.',
      actionLabel: 'Review devices',
      target: { kind: 'panel', panelId: 'devices' },
    });
  });

  it('counts only the last seven local days', () => {
    expect(resolveHardCapReachRecommendations(facts(onDays([0, 3, 7])), NOW, TZ)).toEqual([]);
  });

  it('excludes the eighth calendar day across the spring clock change', () => {
    const now = Date.parse('2026-03-30T00:30:00+02:00');
    const incidents = ['2026-03-23', '2026-03-25', '2026-03-27'].map((day) => ({
      atMs: Date.parse(day + 'T12:00:00+01:00'), hardCapKw: 5, uncontrolledW: 1000,
    }));
    expect(resolveHardCapReachRecommendations(facts(incidents), now, TZ)).toEqual([]);
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

it('keeps the most recent cap when an older request finishes, then retries an unavailable read', async () => {
  const read = vi.mocked(getPowerReadModel);
  let finishEarlier!: (payload: SettingsUiPowerPayload) => void;
  read.mockReturnValueOnce(new Promise((resolve) => { finishEarlier = resolve; }));
  const earlier = loadHardCapReachFacts();
  const power = { capacityScalars: { state: 'resolved', scalars }, hardCapShortfalls: [] } as unknown as SettingsUiPowerPayload;
  read.mockResolvedValueOnce(power);
  await loadHardCapReachFacts();
  finishEarlier({ ...power, capacityScalars: { state: 'resolved', scalars: { ...scalars, limitKw: 9 } } });
  await earlier;
  expect(readHardCapReachFacts()?.scalars.limitKw).toBe(5);
  read.mockResolvedValueOnce({ ...power, capacityScalars: { state: 'unavailable' } });
  await loadHardCapReachFacts();
  expect(readHardCapReachStatus()).toBe('unavailable');
  expect(readHardCapReachFacts()?.scalars.limitKw).toBe(5);
  read.mockResolvedValueOnce(power);
  await loadHardCapReachFacts();
  expect(readHardCapReachStatus()).toBe('resolved');
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
