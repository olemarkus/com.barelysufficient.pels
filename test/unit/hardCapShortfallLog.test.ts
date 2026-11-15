import CapacityGuard from '../../lib/power/capacityGuard';
import { HardCapShortfallLog, type HardCapShortfallEntry } from '../../lib/power/hardCapShortfallLog';
import { createTestCapacityGuard, planVerdictSummaryFixture } from '../helpers/createTestCapacityGuard';

const DAY_MS = 24 * 60 * 60 * 1000;

const memoryStore = (initial: unknown) => {
  let saved: unknown = initial;
  return {
    get: () => saved,
    set: (entries: readonly HardCapShortfallEntry[]) => { saved = entries; },
    saved: () => saved,
  };
};

describe('HardCapShortfallLog', () => {
  it('records nothing until a store is bound', () => {
    const log = new HardCapShortfallLog();
    log.record(1_000, 2_700);
    expect(log.recent(1_000)).toEqual([]);
  });

  it('records the hard cap in force and writes at once', () => {
    const store = memoryStore(undefined);
    const log = new HardCapShortfallLog();
    log.bindStore(store, () => 5);
    log.record(1_000, 2_712.4);
    expect(store.saved()).toEqual([{ atMs: 1_000, hardCapKw: 5, uncontrolledW: 2_712 }]);
  });

  it('keeps a week and drops stored entries that do not read', () => {
    const now = 10 * DAY_MS;
    const store = memoryStore([
      { atMs: now - 8 * DAY_MS, hardCapKw: 5, uncontrolledW: 1_000 },
      { atMs: now - DAY_MS, hardCapKw: 5, uncontrolledW: 1_000 },
      { atMs: now - DAY_MS, hardCapKw: 'five', uncontrolledW: 1_000 },
      null,
    ]);
    const log = new HardCapShortfallLog();
    log.bindStore(store, () => 5);
    expect(log.recent(now)).toEqual([{ atMs: now - DAY_MS, hardCapKw: 5, uncontrolledW: 1_000 }]);
    log.record(now, 500);
    expect(store.saved()).toEqual([
      { atMs: now - DAY_MS, hardCapKw: 5, uncontrolledW: 1_000 },
      { atMs: now, hardCapKw: 5, uncontrolledW: 500 },
    ]);
  });
});

describe('CapacityGuard shortfall log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs each incident it opens, not each verdict', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(50_000);
    const guard: CapacityGuard = createTestCapacityGuard({ homeId: 'main' });
    const store = memoryStore(undefined);
    guard.shortfallLog.bindStore(store, () => 5);
    const summary = { ...planVerdictSummaryFixture({ actionableLoadRemains: false }), uncontrolledPowerW: 2_700 };
    await guard.recordPlanVerdict(5.5, 5, summary);
    await guard.recordPlanVerdict(5.6, 5, summary);
    expect(store.saved()).toEqual([{ atMs: 50_000, hardCapKw: 5, uncontrolledW: 2_700 }]);
  });
});
