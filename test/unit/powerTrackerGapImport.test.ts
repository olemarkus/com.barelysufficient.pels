import { recordPowerSample, type PowerTrackerState } from '../../lib/power/tracker';
import { projectNorwayMonthHistory } from '../../lib/power/norwayMonthlyCapacityHistory';

const METER = 'meter-1';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
// 08:00 in Oslo on 17 November.
const HOUR_START = Date.parse('2026-11-17T07:00:00.000Z');
const HOUR_KEY = new Date(HOUR_START).toISOString();
const NEXT_HOUR_KEY = new Date(HOUR_START + 60 * MINUTE).toISOString();

/** A home sampled every ten seconds whose meter counts what it really imports. */
class SampledHome {
  state: PowerTrackerState = {};
  private counterKWh = 12_345;
  private atMs = HOUR_START;

  /** One sample: the meter reads `powerW` now, and its counter stands at `counterKWh`. */
  async sample(powerW: number, counterKWh?: number): Promise<void> {
    await recordPowerSample({
      state: this.state,
      currentPowerW: powerW,
      nowMs: this.atMs,
      timeZone: 'Europe/Oslo',
      managedDraw: { totalW: 0, loadKey: 0 },
      generationSegments: [],
      ...(counterKWh === undefined
        ? {} : { importCounter: { meterDeviceId: METER, importedKWh: counterKWh, observedAtMs: this.atMs } }),
      rebuildPlanFromCache: async () => undefined,
      saveState: (next) => { this.state = next; },
    });
  }

  /** Sample a steady `powerW` every ten seconds until `untilMs`, the counter following it. */
  async runSteady(powerW: number, untilMs: number): Promise<void> {
    await this.sample(powerW, this.counterKWh);
    while (this.atMs < untilMs) {
      this.atMs += 10 * SECOND;
      this.counterKWh += (powerW / 1000) * (10 / 3600);
      await this.sample(powerW, this.counterKWh);
    }
  }

  /** PELS takes no sample for `gapMs` while the home draws `realPowerW`; the meter keeps counting. */
  passUnsampled(gapMs: number, realPowerW: number): void {
    this.atMs += gapMs;
    this.counterKWh += (realPowerW / 1000) * (gapMs / 3_600_000);
  }

  get counter(): number { return this.counterKWh; }
}

describe('a gap between two whole-home readings', () => {
  it('books the counter step for a 15-minute gap inside one hour and leaves the hour reliable', async () => {
    const home = new SampledHome();
    await home.runSteady(6000, HOUR_START + 11 * MINUTE);
    home.passUnsampled(15 * MINUTE, 3000);
    await home.sample(3000, home.counter);

    // 11 minutes at 6 kW, then the 0.75 kWh the meter counted, not 15 more minutes at 6 kW.
    expect(home.state.buckets?.[HOUR_KEY]).toBeCloseTo(1.1 + 0.75, 3);
    expect(home.state.unreliablePeriods ?? []).toEqual([]);
    expect(home.state.importCounter).toMatchObject({ importedKWh: home.counter, verified: true });
  });

  it('splits the counter step over both hours of a gap that crosses the hour', async () => {
    const home = new SampledHome();
    await home.runSteady(6000, HOUR_START + 50 * MINUTE);
    home.passUnsampled(20 * MINUTE, 3000);
    await home.sample(3000, home.counter);

    expect(home.state.buckets?.[HOUR_KEY]).toBeCloseTo(5 + 0.5, 3);
    expect(home.state.buckets?.[NEXT_HOUR_KEY]).toBeCloseTo(0.5, 3);
    expect(home.state.unreliablePeriods ?? []).toEqual([]);
  });

  it('counts the recovered energy as background', async () => {
    const home = new SampledHome();
    home.state = { lastUncontrolledPowerW: 0, lastControlledPowerW: 0 };
    const sampleWithSplit = async (powerW: number): Promise<void> => {
      const { state } = home;
      await recordPowerSample({
        state,
        currentPowerW: powerW,
        controlledPowerW: powerW,
        nowMs: (state.lastTimestamp ?? HOUR_START - 10 * SECOND) + 10 * SECOND,
        timeZone: 'Europe/Oslo',
        managedDraw: { totalW: 0, loadKey: 0 },
        generationSegments: [],
        importCounter: {
          meterDeviceId: METER,
          importedKWh: 500 + ((state.buckets?.[HOUR_KEY] ?? 0) + (powerW / 1000) * (10 / 3600)),
          observedAtMs: (state.lastTimestamp ?? HOUR_START - 10 * SECOND) + 10 * SECOND,
        },
        rebuildPlanFromCache: async () => undefined,
        saveState: (next) => { home.state = next; },
      });
    };
    for (let index = 0; index < 60; index += 1) await sampleWithSplit(6000);
    const before = home.state;
    const gapEndMs = (before.lastTimestamp as number) + 15 * MINUTE;
    await recordPowerSample({
      state: before,
      currentPowerW: 6000,
      controlledPowerW: 6000,
      nowMs: gapEndMs,
      timeZone: 'Europe/Oslo',
      managedDraw: { totalW: 0, loadKey: 0 },
      generationSegments: [],
      importCounter: {
        meterDeviceId: METER,
        importedKWh: (before.importCounter?.importedKWh as number) + 0.75,
        observedAtMs: gapEndMs,
      },
      rebuildPlanFromCache: async () => undefined,
      saveState: (next) => { home.state = next; },
    });

    const controlledBefore = before.controlledBuckets?.[HOUR_KEY] ?? 0;
    expect(home.state.controlledBuckets?.[HOUR_KEY] ?? 0).toBeCloseTo(controlledBefore, 6);
    expect((home.state.uncontrolledBuckets?.[HOUR_KEY] ?? 0) - (before.uncontrolledBuckets?.[HOUR_KEY] ?? 0))
      .toBeCloseTo(0.75, 2);
  });

  it('fills only up to when the meter last changed the counter, and the rest from the held reading', async () => {
    const home = new SampledHome();
    await home.runSteady(6000, HOUR_START + 11 * MINUTE);
    const gapStartMs = home.state.lastTimestamp as number;
    // The meter last moved its counter ten minutes into the gap.
    await recordPowerSample({
      state: home.state,
      currentPowerW: 3000,
      nowMs: gapStartMs + 15 * MINUTE,
      timeZone: 'Europe/Oslo',
      managedDraw: { totalW: 0, loadKey: 0 },
      generationSegments: [],
      importCounter: { meterDeviceId: METER, importedKWh: home.counter + 0.5, observedAtMs: gapStartMs + 10 * MINUTE },
      rebuildPlanFromCache: async () => undefined,
      saveState: (next) => { home.state = next; },
    });

    // 0.5 kWh from the counter, then five minutes of the held 6 kW.
    expect(home.state.buckets?.[HOUR_KEY]).toBeCloseTo(1.1 + 0.5 + 0.5, 3);
  });

  describe('falls back to the held reading', () => {
    const heldAcrossGap = 6 * (26 / 60);

    it.each([
      ['goes backwards', (counter: number) => counter - 10.07],
      ['jumps past what the home can draw', (counter: number) => counter + 3_054_125],
      ['is missing', () => undefined],
    ])('when the counter %s', async (_name, counterAfterGap) => {
      const home = new SampledHome();
      await home.runSteady(6000, HOUR_START + 11 * MINUTE);
      home.passUnsampled(15 * MINUTE, 3000);
      await home.sample(3000, counterAfterGap(home.counter));

      expect(home.state.buckets?.[HOUR_KEY]).toBeCloseTo(heldAcrossGap, 3);
    });

    it('when the counter before the gap was itself a bad value', async () => {
      const home = new SampledHome();
      await home.runSteady(6000, HOUR_START + 11 * MINUTE - 10 * SECOND);
      // The last sample before the gap carries a counter ten kilowatt-hours low.
      home.passUnsampled(10 * SECOND, 6000);
      await home.sample(6000, home.counter - 10.07);
      home.passUnsampled(15 * MINUTE, 3000);
      await home.sample(3000, home.counter);

      expect(home.state.buckets?.[HOUR_KEY]).toBeCloseTo(heldAcrossGap, 3);
      expect(home.state.importCounter?.verified).toBe(false);
    });

    it('when the bad value before the gap was followed by a step that agrees', async () => {
      const home = new SampledHome();
      await home.runSteady(6000, HOUR_START + 11 * MINUTE - 20 * SECOND);
      home.passUnsampled(10 * SECOND, 6000);
      await home.sample(6000, home.counter - 10.07);
      // The counter keeps counting from the low value, then comes back across the gap.
      home.passUnsampled(10 * SECOND, 6000);
      await home.sample(6000, home.counter - 10.07);
      home.passUnsampled(15 * MINUTE, 3000);
      await home.sample(3000, home.counter);

      expect(home.state.buckets?.[HOUR_KEY]).toBeCloseTo(heldAcrossGap, 3);
    });

    it('when the meter has not changed the counter since the gap began', async () => {
      const home = new SampledHome();
      await home.runSteady(6000, HOUR_START + 11 * MINUTE);
      const gapStartMs = home.state.lastTimestamp as number;
      await recordPowerSample({
        state: home.state,
        currentPowerW: 3000,
        nowMs: gapStartMs + 15 * MINUTE,
        timeZone: 'Europe/Oslo',
        managedDraw: { totalW: 0, loadKey: 0 },
        generationSegments: [],
        importCounter: { meterDeviceId: METER, importedKWh: home.counter, observedAtMs: gapStartMs },
        rebuildPlanFromCache: async () => undefined,
        saveState: (next) => { home.state = next; },
      });

      expect(home.state.buckets?.[HOUR_KEY]).toBeCloseTo(heldAcrossGap, 3);
    });

    it('and flags a gap that crosses the hour as unreliable', async () => {
      const home = new SampledHome();
      await home.runSteady(6000, HOUR_START + 50 * MINUTE);
      const gapStartMs = home.state.lastTimestamp as number;
      home.passUnsampled(20 * MINUTE, 3000);
      await home.sample(3000, home.counter - 5);

      expect(home.state.unreliablePeriods).toEqual([{ start: gapStartMs, end: gapStartMs + 20 * MINUTE }]);
    });
  });

  it('keeps a gap longer than an hour flagged while booking the counter total', async () => {
    const home = new SampledHome();
    await home.runSteady(6000, HOUR_START + 30 * MINUTE);
    const gapStartMs = home.state.lastTimestamp as number;
    home.passUnsampled(120 * MINUTE, 2000);
    await home.sample(2000, home.counter);

    const total = Object.values(home.state.buckets ?? {}).reduce((sum, kWh) => sum + kWh, 0);
    expect(total).toBeCloseTo(3 + 4, 2);
    expect(home.state.unreliablePeriods).toEqual([{ start: gapStartMs, end: gapStartMs + 120 * MINUTE }]);
  });

  it('shows the recovered hour as the day peak in the Monthly capacity history', async () => {
    const home = new SampledHome();
    await home.runSteady(3000, HOUR_START + 11 * MINUTE);
    home.passUnsampled(40 * MINUTE, 6500);
    await home.runSteady(6000, HOUR_START + 60 * MINUTE);

    const history = projectNorwayMonthHistory(home.state, HOUR_START + 90 * MINUTE);
    const peak = history.peaks.find((entry) => entry.dateKey === '2026-11-17');
    // 11 min at 3 kW, 40 min at 6.5 kW from the counter, 9 min at 6 kW: the held 3 kW would give 3.45.
    expect(peak?.hourStartMs).toBe(HOUR_START);
    expect(peak?.kw).toBeCloseTo(0.55 + 4.333 + 0.9, 2);
  });
});
