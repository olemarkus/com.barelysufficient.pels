import type Homey from 'homey';
import { MockSettings, mockHomeyInstance } from '../mocks/homey';
import { startSoleMeterAdoption } from '../../setup/soleMeterAdoption';
import { classifySoleMeterAdoptionEligibility } from '../../setup/soleMeterAdoptionEligibility';
import { TimerRegistry } from '../../lib/utils/timerRegistry';

const METER_ID = 'meter-device-1';
const OTHER_METER_ID = 'meter-device-2';

const makeHomey = (initial: Record<string, unknown>): Homey.App['homey'] => {
  const settings = new MockSettings();
  for (const [key, value] of Object.entries(initial)) settings.set(key, value);
  return { settings } as unknown as Homey.App['homey'];
};

// A fresh install never has an empty key list by the time the adoption
// classifies: the boot migrations run first and set their markers.
const FRESH_INSTALL_BASE = { boot_migrations_v1_ev_setting_cleanup_done: true };

const cumulative = (id: string, watts: number) => ({ type: 'cumulative', id, values: { W: watts } });
const soleMeterReport = { items: [cumulative(METER_ID, 1200)] };
const otherSoleMeterReport = { items: [cumulative(OTHER_METER_ID, 900)] };
const multiMeterReport = { items: [cumulative(METER_ID, 1200), cumulative(OTHER_METER_ID, 900)] };
const idlessAggregateReport = { items: [{ type: 'cumulative', values: { W: 640 } }] };

const meterDevice = (id: string) => ({ id, name: id, class: 'sensor', capabilities: ['measure_power'] });
const registryOf = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, meterDevice(id)]));

type CensusLane = 'report' | 'devices';
/** What the mock REST client's `get` resolves to; the stub answers in that shape. */
type ApiGetResult = Awaited<ReturnType<typeof mockHomeyInstance.api.get>>;
type LaneAnswer = { kind: 'value'; value: unknown } | { kind: 'reject'; error: Error };

// The census is driven through the Homey SDK boundary the transport reads
// (`manager/energy/live` and `manager/devices/device` on the mock REST client),
// never by replacing transport functions.
const stubCensus = (report: unknown, registry: unknown = registryOf(METER_ID)) => {
  const answers: Record<CensusLane, LaneAnswer> = {
    report: { kind: 'value', value: report },
    devices: { kind: 'value', value: registry },
  };
  const calls: Record<CensusLane, number> = { report: 0, devices: 0 };
  const lanes: Record<string, CensusLane> = { 'manager/energy/live': 'report', 'manager/devices/device': 'devices' };
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    const lane = lanes[path];
    if (lane === undefined) throw new Error(`unexpected Homey API path ${path}`);
    calls[lane] += 1;
    const answer = answers[lane];
    if (answer.kind === 'reject') throw answer.error;
    return answer.value as ApiGetResult;
  });
  const control = (lane: CensusLane) => ({
    mockResolvedValue: (value: unknown): void => { answers[lane] = { kind: 'value', value }; },
    mockRejectedValue: (error: Error): void => { answers[lane] = { kind: 'reject', error }; },
    calls: (): number => calls[lane],
  });
  return { report: control('report'), devices: control('devices') };
};

const run = (
  homey: Homey.App['homey'],
  timers = new TimerRegistry(),
  inMemoryLastSampleMs?: number,
): TimerRegistry => {
  startSoleMeterAdoption(homey, timers, () => inMemoryLastSampleMs);
  return timers;
};

// A plausible blank tracker: what the tracker's first prune persists 10 s
// after boot on an install that has never received a reading.
const BLANK_TRACKER = {};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('classifySoleMeterAdoptionEligibility', () => {
  it('is settled by an explicit flow source, including a garbage string that normalizes to flow', () => {
    expect(classifySoleMeterAdoptionEligibility(makeHomey({ power_source: 'flow' }).settings))
      .toEqual({ kind: 'settled', detail: 'flow_source' });
    expect(classifySoleMeterAdoptionEligibility(makeHomey({ power_source: 'wibble' }).settings))
      .toEqual({ kind: 'settled', detail: 'flow_source' });
  });

  it('is settled by homey_energy with a valid explicit meter', () => {
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: METER_ID });
    expect(classifySoleMeterAdoptionEligibility(homey.settings)).toEqual({ kind: 'settled', detail: 'explicit_meter' });
  });

  it('defers on a malformed stored meter id instead of adopting over it', () => {
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: 'bad|id' });
    expect(classifySoleMeterAdoptionEligibility(homey.settings)).toEqual({ kind: 'defer', reasonCode: 'suspect_meter_value' });
    // A non-string, non-absent value is a read of SOMETHING, even when the key list omits the key.
    const odd = { get: (key: string) => (key === 'homey_energy_meter_device_id' ? 42 : 'homey_energy'), getKeys: () => ['power_source'] };
    expect(classifySoleMeterAdoptionEligibility(odd)).toEqual({ kind: 'defer', reasonCode: 'suspect_meter_value' });
  });

  it('is eligible for homey_energy with a stored-null or never-written meter, and says which', () => {
    expect(classifySoleMeterAdoptionEligibility(
      makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null }).settings,
    )).toEqual({ kind: 'eligible', detail: 'no_meter_chosen', meterKey: 'listed_null' });
    expect(classifySoleMeterAdoptionEligibility(makeHomey({ power_source: 'homey_energy' }).settings))
      .toEqual({ kind: 'eligible', detail: 'no_meter_chosen', meterKey: 'unwritten' });
  });

  it('is eligible for an unset source, regardless of any persisted history', () => {
    expect(classifySoleMeterAdoptionEligibility(makeHomey({ ...FRESH_INSTALL_BASE }).settings))
      .toEqual({ kind: 'eligible', detail: 'unset_source', meterKey: 'unwritten' });
    expect(classifySoleMeterAdoptionEligibility(
      makeHomey({ ...FRESH_INSTALL_BASE, power_tracker_state: { lastPowerW: 500 } }).settings,
    )).toEqual({ kind: 'eligible', detail: 'unset_source', meterKey: 'unwritten' });
  });

  it('completes a half-applied save: an explicit meter with no source keeps its meter and gains the source', () => {
    expect(classifySoleMeterAdoptionEligibility(
      makeHomey({ ...FRESH_INSTALL_BASE, homey_energy_meter_device_id: METER_ID }).settings,
    )).toEqual({ kind: 'complete', meterDeviceId: METER_ID });
    expect(classifySoleMeterAdoptionEligibility(
      makeHomey({ ...FRESH_INSTALL_BASE, homey_energy_meter_device_id: 'bad|id' }).settings,
    )).toEqual({ kind: 'defer', reasonCode: 'suspect_meter_value' });
  });

  it('defers when a listed key transiently answers undefined, and on an empty key list or a throwing read', () => {
    const store: Record<string, unknown> = { power_source: 'homey_energy', homey_energy_meter_device_id: METER_ID };
    const transientMeter = {
      get: (key: string) => (key === 'homey_energy_meter_device_id' ? undefined : store[key]),
      getKeys: () => Object.keys(store),
    };
    expect(classifySoleMeterAdoptionEligibility(transientMeter)).toEqual({ kind: 'defer', reasonCode: 'missing_existing_key' });
    const transientSource = { get: () => undefined, getKeys: () => ['power_source'] };
    expect(classifySoleMeterAdoptionEligibility(transientSource)).toEqual({ kind: 'defer', reasonCode: 'missing_existing_key' });
    expect(classifySoleMeterAdoptionEligibility(new MockSettings())).toEqual({ kind: 'defer', reasonCode: 'empty_key_list' });
    expect(classifySoleMeterAdoptionEligibility({ get: () => { throw new Error('boom'); }, getKeys: () => [] }))
      .toEqual({ kind: 'defer', reasonCode: 'read_failed' });
  });
});

describe('runSoleMeterAdoption', () => {
  it('adopts the sole meter for a fresh install on the second agreeing read, even when the tracker persists mid-window', async () => {
    vi.useFakeTimers();
    stubCensus(soleMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    // The power tracker's first prune persists its state 10 s after boot.
    // This is the write that made the previous design flip a fresh install to
    // Flow; the adoption must not look at it.
    setTimeout(() => homey.settings.set('power_tracker_state', BLANK_TRACKER), 10_000);
    run(homey);
    await vi.advanceTimersByTimeAsync(30_000);
    // One read only proposes.
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(homey.settings.get('power_source')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
  });

  it('adopts for a legacy Automatic install (stored-null meter) on the third consistent read, with a single-key write', async () => {
    vi.useFakeTimers();
    stubCensus(soleMeterReport);
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    const writes = vi.spyOn(homey.settings, 'set');
    run(homey);
    // Two agreeing reads are not enough for a LISTED null: the grace holds.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
    expect(writes.mock.calls.filter(([key]) => key === 'power_source')).toHaveLength(0);
  });

  it('never adopts over an explicit meter that transiently reads null on the first reads', async () => {
    vi.useFakeTimers();
    stubCensus(otherSoleMeterReport, registryOf(OTHER_METER_ID));
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: METER_ID });
    const originalGet = homey.settings.get.bind(homey.settings);
    let reads = 0;
    vi.spyOn(homey.settings, 'get').mockImplementation((key: string) => {
      if (key !== 'homey_energy_meter_device_id') return originalGet(key);
      reads += 1;
      // The stored id goes missing for the boot read and both reads of the first two attempts.
      return reads <= 5 ? null : originalGet(key);
    });
    const timers = run(homey);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(originalGet('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('never adopts over an explicit meter that alternates between its id and null across reads', async () => {
    vi.useFakeTimers();
    stubCensus(otherSoleMeterReport, registryOf(OTHER_METER_ID));
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: METER_ID });
    const originalGet = homey.settings.get.bind(homey.settings);
    let reads = 0;
    vi.spyOn(homey.settings, 'get').mockImplementation((key: string) => {
      if (key !== 'homey_energy_meter_device_id') return originalGet(key);
      reads += 1;
      // Boot read null; then every attempt's first read null, second read the real id.
      return reads % 2 === 1 ? null : originalGet(key);
    });
    const timers = run(homey);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(originalGet('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('never fetches for a settled install (flow, or an explicit meter)', async () => {
    vi.useFakeTimers();
    const { report } = stubCensus(soleMeterReport);
    const timers = new TimerRegistry();
    run(makeHomey({ power_source: 'flow' }), timers);
    run(makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: OTHER_METER_ID }), timers);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(report.calls()).toBe(0);
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('writes nothing and stops for several live meters, a sole id-less aggregate, or a registry that disagrees', async () => {
    vi.useFakeTimers();
    const cases: Array<[unknown, unknown]> = [
      [multiMeterReport, registryOf(METER_ID, OTHER_METER_ID)],
      [idlessAggregateReport, registryOf(METER_ID)],
      // The registry knows a second meter that has not published yet.
      [soleMeterReport, registryOf(METER_ID, OTHER_METER_ID)],
    ];
    for (const [liveReport, registry] of cases) {
      const { report } = stubCensus(liveReport, registry);
      const homey = makeHomey({ ...FRESH_INSTALL_BASE });
      const timers = run(homey);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(homey.settings.get('power_source')).toBeNull();
      expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
      expect(report.calls()).toBe(1);
      expect(timers.has('soleMeterAdoption')).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it('retries an unavailable report, a failed or empty registry read, and an empty report, then adopts once two reads agree', async () => {
    vi.useFakeTimers();
    const { report, devices } = stubCensus(null);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    run(homey);
    await vi.advanceTimersByTimeAsync(30_000);
    // An uninitialised REST client answers null for the report; the registry is not asked.
    expect(devices.calls()).toBe(0);
    report.mockResolvedValue(soleMeterReport);
    devices.mockRejectedValue(new Error('REST client not initialized'));
    await vi.advanceTimersByTimeAsync(30_000);
    // A registry with no device record at all — empty, or a keyed error body —
    // is a malformed or transient read, not evidence.
    devices.mockResolvedValue({});
    await vi.advanceTimersByTimeAsync(30_000);
    devices.mockResolvedValue({ error: 'temporarily unavailable' });
    await vi.advanceTimersByTimeAsync(30_000);
    devices.mockResolvedValue(registryOf(METER_ID));
    report.mockResolvedValue({ items: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('power_source')).toBeNull();
    report.mockResolvedValue(soleMeterReport);
    await vi.advanceTimersByTimeAsync(30_000);
    // Attempt 6 proposes; attempt 7 confirms.
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
  });

  it('keeps trying, then gives up, when the registry never corroborates the live meter', async () => {
    vi.useFakeTimers();
    const { report } = stubCensus(soleMeterReport, { plug: { id: 'plug', name: 'Plug', class: 'socket' } });
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    const timers = run(homey);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(report.calls()).toBe(10);
    expect(homey.settings.get('power_source')).toBeNull();
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('gives up for this boot after the retry ladder when no meter ever appears, writing nothing', async () => {
    vi.useFakeTimers();
    const { report } = stubCensus({ items: [] });
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    const timers = run(homey);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(report.calls()).toBe(10);
    expect(homey.settings.get('power_source')).toBeNull();
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('stops without writing when the owner chooses a source between the two reads', async () => {
    vi.useFakeTimers();
    const { report } = stubCensus(soleMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    const timers = run(homey);
    await vi.advanceTimersByTimeAsync(30_000);
    homey.settings.set('power_source', 'flow');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(homey.settings.get('power_source')).toBe('flow');
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    // The settled answer is read before the second census, so no second fetch.
    expect(report.calls()).toBe(1);
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('does not adopt over readings that EVER arrived on an install that never wrote the source (a Flow feed)', async () => {
    vi.useFakeTimers();
    const { report } = stubCensus(soleMeterReport);
    // The unset-source arm asks for the tracker's whole history: Flows fire on
    // their own cadence, so a quiet first minute proves nothing. The last
    // persisted reading here is hours old.
    const homey = makeHomey({
      ...FRESH_INSTALL_BASE,
      power_tracker_state: { lastTimestamp: Date.now() - 3 * 3_600_000, lastPowerW: 800 },
    });
    const timers = run(homey);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(homey.settings.get('power_source')).toBeNull();
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(report.calls()).toBe(2);
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('does not adopt over a reading admitted in memory since the run started, whatever is persisted', async () => {
    vi.useFakeTimers();
    stubCensus(soleMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    const timers = run(homey, new TimerRegistry(), Date.now() + 15_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(homey.settings.get('power_source')).toBeNull();
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('adopts for a legacy Automatic install despite old samples: only readings since this run count there', async () => {
    vi.useFakeTimers();
    stubCensus(soleMeterReport);
    const homey = makeHomey({
      power_source: 'homey_energy',
      homey_energy_meter_device_id: null,
      power_tracker_state: { lastTimestamp: Date.now() - 3 * 3_600_000, lastPowerW: 800 },
    });
    run(homey, new TimerRegistry(), Date.now() - 3 * 3_600_000);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
  });

  it('decides nothing this boot when the persisted tracker cannot be read (a transient, not "never")', async () => {
    vi.useFakeTimers();
    const { report } = stubCensus(soleMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE, power_tracker_state: 'garbage' });
    const timers = run(homey);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(homey.settings.get('power_source')).toBeNull();
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(report.calls()).toBe(10);
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('keeps a suspect history read for the whole run: a blank tracker persisted later is no evidence', async () => {
    vi.useFakeTimers();
    const { report } = stubCensus(soleMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE, power_tracker_state: 'garbage' });
    const timers = run(homey);
    // The prune persists the blank in-memory tracker 10 s after boot.
    setTimeout(() => homey.settings.set('power_tracker_state', BLANK_TRACKER), 10_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(report.calls()).toBe(10);
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('reads Flow history before the prune can overwrite it', async () => {
    vi.useFakeTimers();
    stubCensus(soleMeterReport);
    const homey = makeHomey({
      ...FRESH_INSTALL_BASE,
      power_tracker_state: { lastTimestamp: Date.now() - 3 * 3_600_000, lastPowerW: 800 },
    });
    const timers = run(homey);
    setTimeout(() => homey.settings.set('power_tracker_state', BLANK_TRACKER), 10_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(homey.settings.get('power_source')).toBeNull();
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('restarts the listed-null grace after a deferred read in between', async () => {
    vi.useFakeTimers();
    stubCensus(soleMeterReport);
    const homey = makeHomey({ power_source: 'homey_energy', homey_energy_meter_device_id: null });
    const originalGet = homey.settings.get.bind(homey.settings);
    let reads = 0;
    vi.spyOn(homey.settings, 'get').mockImplementation((key: string) => {
      if (key !== 'homey_energy_meter_device_id') return originalGet(key);
      reads += 1;
      // Boot read null; attempt 1 null/null; attempt 2 opens with a transient `undefined`.
      return reads === 4 ? undefined : originalGet(key);
    });
    run(homey);
    // Attempts 1-3: null (streak 1), undefined (defer, streak reset), null (streak 1).
    await vi.advanceTimersByTimeAsync(90_000);
    expect(originalGet('homey_energy_meter_device_id')).toBeNull();
    // Attempts 4-5: null (streak 2, hold), null (streak 3, confirm).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(originalGet('homey_energy_meter_device_id')).toBe(METER_ID);
  });

  it('refuses a sole meter that a meter area already owns, and stops', async () => {
    vi.useFakeTimers();
    stubCensus(soleMeterReport);
    const homey = makeHomey({
      ...FRESH_INSTALL_BASE,
      homes_config: {
        activationVersion: 1,
        subHomes: [{ homeId: 'area-1', name: 'Rental', rootZoneId: 'zone-1', meterDeviceId: METER_ID }],
      },
    });
    const timers = run(homey);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(homey.settings.get('power_source')).toBeNull();
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('finishes a half-applied save with the stored meter, without a census', async () => {
    vi.useFakeTimers();
    const { report } = stubCensus(otherSoleMeterReport, registryOf(OTHER_METER_ID));
    const homey = makeHomey({ ...FRESH_INSTALL_BASE, homey_energy_meter_device_id: METER_ID });
    const timers = run(homey);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
    expect(report.calls()).toBe(0);
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('retries a throwing source write, then completes the pair on the next attempt', async () => {
    vi.useFakeTimers();
    stubCensus(soleMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    const originalSet = homey.settings.set.bind(homey.settings);
    let sourceWrites = 0;
    vi.spyOn(homey.settings, 'set').mockImplementation((key: string, value: unknown) => {
      if (key === 'power_source') {
        sourceWrites += 1;
        if (sourceWrites === 1) throw new Error('settings write failed');
      }
      originalSet(key, value);
    });
    run(homey);
    await vi.advanceTimersByTimeAsync(60_000);
    // The meter half landed; the source half threw.
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(homey.settings.get('power_source')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('power_source')).toBe('homey_energy');
  });

  it('does not complete a half-applied save over a Flow that started feeding since this run', async () => {
    vi.useFakeTimers();
    stubCensus(soleMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE, homey_energy_meter_device_id: METER_ID });
    const timers = run(homey, new TimerRegistry(), Date.now() + 15_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(homey.settings.get('power_source')).toBeNull();
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('keeps the proposed meter across a transient census failure, and confirms on the next usable read', async () => {
    vi.useFakeTimers();
    const { report } = stubCensus(soleMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    run(homey);
    await vi.advanceTimersByTimeAsync(30_000);
    report.mockRejectedValue(new Error('transient'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    report.mockResolvedValue(soleMeterReport);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
  });

  it('restarts the confirmation when a report answers with no meter in between', async () => {
    vi.useFakeTimers();
    const { report } = stubCensus(soleMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    run(homey);
    await vi.advanceTimersByTimeAsync(30_000);
    report.mockResolvedValue({ items: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    report.mockResolvedValue(soleMeterReport);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(METER_ID);
  });

  it('requires two CONSECUTIVE reads to agree: a different sole meter restarts the confirmation', async () => {
    vi.useFakeTimers();
    const { report, devices } = stubCensus(soleMeterReport, registryOf(METER_ID));
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    run(homey);
    await vi.advanceTimersByTimeAsync(30_000);
    report.mockResolvedValue(otherSoleMeterReport);
    devices.mockResolvedValue(registryOf(OTHER_METER_ID));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBe(OTHER_METER_ID);
  });

  it('still runs the ladder after a transient miss on the first source-key read', async () => {
    vi.useFakeTimers();
    stubCensus(soleMeterReport);
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    const originalGet = homey.settings.get.bind(homey.settings);
    let sourceReads = 0;
    vi.spyOn(homey.settings, 'get').mockImplementation((key: string) => {
      if (key !== 'power_source') return originalGet(key);
      sourceReads += 1;
      if (sourceReads === 1) throw new Error('transient settings read failure');
      return originalGet(key);
    });
    run(homey);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(originalGet('homey_energy_meter_device_id')).toBe(METER_ID);
    expect(originalGet('power_source')).toBe('homey_energy');
  });

  it('holds the whole boot when the tracker history cannot be read at start (an empty key list)', async () => {
    vi.useFakeTimers();
    const { report } = stubCensus(soleMeterReport);
    const homey = makeHomey({});
    setTimeout(() => homey.settings.set('boot_migrations_v1_ev_setting_cleanup_done', true), 5_000);
    const timers = run(homey);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(report.calls()).toBe(10);
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });

  it('writes nothing when the app tears down while the CONFIRMING read is in flight', async () => {
    vi.useFakeTimers();
    let resolveReport: (value: ApiGetResult) => void = () => {};
    let call = 0;
    vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
      if (path === 'manager/devices/device') return registryOf(METER_ID);
      call += 1;
      if (call === 1) return soleMeterReport;
      return new Promise<ApiGetResult>((resolve) => { resolveReport = resolve; });
    });
    const homey = makeHomey({ ...FRESH_INSTALL_BASE });
    const timers = run(homey);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(call).toBe(2);
    timers.clearAll();
    resolveReport(soleMeterReport);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(homey.settings.get('power_source')).toBeNull();
    expect(homey.settings.get('homey_energy_meter_device_id')).toBeNull();
    expect(timers.has('soleMeterAdoption')).toBe(false);
  });
});
