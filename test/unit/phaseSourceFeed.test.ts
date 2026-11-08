import { observeFlowSamplePhases } from '../../setup/phaseSourceFeed';
import { PhaseReadingTracker } from '../../lib/power/phaseReading';
import { PhaseReadFlight } from '../../lib/power/phaseReadFlight';
import { PhasePeakLog, parsePhasePeaks } from '../../lib/power/phasePeakLog';

describe('phases beside a Flow sample', () => {
  const ctxWith = (meterId: string | null) => {
    const readings = new PhaseReadingTracker();
    return {
      homey: { settings: { get: (key: string) => (key === 'main_fuse_phase_meter_device_id' ? meterId : null) } },
      capacityGuard: { phaseReadings: readings, phaseReadFlight: new PhaseReadFlight() },
      getNow: () => new Date(1),
      deviceManager: { readMeterPhases: vi.fn(async () => ({
        state: 'read', capabilityIds: [], powerW: [1000, 1000, 1000],
      })) },
    };
  };
  const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

  it('reads the picked meter without holding the sample, and admits what comes back', async () => {
    const ctx = ctxWith('meter');
    observeFlowSamplePhases(ctx as never, 3000, 1);
    expect(ctx.capacityGuard.phaseReadings.current().kind).toBe('none');
    await settle();
    expect(ctx.deviceManager.readMeterPhases).toHaveBeenCalledWith('meter', null);
    expect(ctx.capacityGuard.phaseReadings.current().kind).toBe('healthy');
  });

  it('resets a frozen set when no meter is picked any more', async () => {
    const ctx = ctxWith('meter');
    observeFlowSamplePhases(ctx as never, 3000, 1);
    await settle();
    expect(ctx.capacityGuard.phaseReadings.current().kind).toBe('healthy');
    const cleared = { ...ctx, homey: { settings: { get: () => null } } };
    observeFlowSamplePhases(cleared as never, 3000, 2);
    expect(ctx.capacityGuard.phaseReadings.current().kind).toBe('none');
  });
});

describe('PhaseReadFlight', () => {
  const answer = { state: 'read', capabilityIds: [], powerW: [1, 1, 1] } as const;
  const deferred = () => {
    let resolve!: (value: typeof answer) => void;
    const promise = new Promise<typeof answer>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

  it('starts one read at a time and a later sample uses what is already known', () => {
    const flight = new PhaseReadFlight();
    const read = vi.fn(() => deferred().promise);
    flight.begin(read, vi.fn(), 0, () => 0);
    flight.begin(read, vi.fn(), 1_000, () => 1_000);
    expect(read).toHaveBeenCalledOnce();
  });

  it('drops an answer that comes past the deadline, and tries again after it', async () => {
    const flight = new PhaseReadFlight();
    const slow = deferred();
    const admit = vi.fn();
    let now = 0;
    flight.begin(() => slow.promise, admit, 0, () => now);
    now = 4_000;
    slow.resolve(answer);
    await settle();
    expect(admit).not.toHaveBeenCalled();
    const read = vi.fn(async () => answer);
    flight.begin(read, admit, 4_000, () => 4_000);
    await settle();
    expect(admit).toHaveBeenCalledOnce();
  });
});

describe('phase peaks log', () => {
  const over = (phase: 'L1' | 'L2' | 'L3', drawKw: number) => ({ phase, drawKw, breached: true, exportBreached: false });
  const under = (phase: 'L1' | 'L2' | 'L3') => ({ phase, drawKw: 1, breached: false, exportBreached: false });

  it('records one episode with its peak, duration and who was drawing at the peak', () => {
    const log = new PhasePeakLog();
    log.observe(0, [over('L1', 6)], ['Heater']);
    log.observe(30_000, [over('L1', 7)], ['Heater', 'EV']);
    log.observe(60_000, [over('L1', 6.5)], ['EV']);
    log.observe(90_000, [under('L1')], []);
    log.observe(121_000, [under('L1')], []);
    expect(log.recent(121_000)).toEqual([{
      phase: 'L1', direction: 'import', startedAtMs: 0, durationS: 60, peakKw: 7, devices: ['Heater', 'EV'],
    }]);
  });

  it('counts a brief dip as the same peak', () => {
    const log = new PhasePeakLog();
    log.observe(0, [over('L1', 6)], []);
    log.observe(30_000, [under('L1')], []);
    log.observe(50_000, [over('L1', 6)], []);
    log.observe(120_000, [under('L1')], []);
    expect(log.recent(120_000)).toMatchObject([{ startedAtMs: 0, durationS: 50 }]);
  });

  it('drops an episode too short to matter', () => {
    const log = new PhasePeakLog();
    log.observe(0, [over('L1', 6)], []);
    log.observe(10_000, [over('L1', 6)], []);
    log.observe(80_000, [under('L1')], []);
    expect(log.recent(80_000)).toEqual([]);
  });

  it('does not stretch an episode across a gap in the samples', () => {
    const log = new PhasePeakLog();
    log.observe(0, [over('L1', 6)], []);
    log.observe(40_000, [over('L1', 6)], []);
    log.observe(600_000, [over('L1', 6)], []);
    expect(log.recent(600_000)).toMatchObject([{ startedAtMs: 0, durationS: 40 }]);
  });

  it('records export episodes by magnitude', () => {
    const log = new PhasePeakLog();
    log.observe(0, [{ phase: 'L2', drawKw: -6, breached: false, exportBreached: true }], []);
    log.observe(40_000, [{ phase: 'L2', drawKw: -6, breached: false, exportBreached: true }], []);
    log.observe(101_000, [under('L2')], []);
    expect(log.recent(101_000)).toMatchObject([{ phase: 'L2', direction: 'export', peakKw: 6 }]);
  });

  it('stores only finished episodes, throttled, and keeps a week', () => {
    const saved: unknown[] = [];
    const log = new PhasePeakLog();
    log.bindStore({ get: () => null, set: (entries) => saved.push(entries) });
    log.observe(0, [over('L1', 6)], []);
    log.observe(40_000, [over('L1', 6)], []);
    expect(saved).toHaveLength(0);
    log.observe(101_000, [under('L1')], []);
    expect(saved).toHaveLength(1);
    log.observe(102_000, [over('L2', 6)], []);
    log.observe(142_000, [over('L2', 6)], []);
    log.observe(203_000, [under('L2')], []);
    expect(saved).toHaveLength(2);
    expect(log.recent(8 * 24 * 60 * 60 * 1000)).toEqual([]);
  });

  it('validates stored entries one by one', () => {
    expect(parsePhasePeaks([
      { phase: 'L1', direction: 'import', startedAtMs: 1, durationS: 2, peakKw: 3, devices: [] },
      { phase: 'L9' },
      'nope',
    ])).toHaveLength(1);
    expect(parsePhasePeaks('nope')).toEqual([]);
  });
});
