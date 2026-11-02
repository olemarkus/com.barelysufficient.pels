import { describe, expect, it } from 'vitest';
import { BatteryEfficiencyLearner } from '../../lib/battery/batteryEfficiencyLearner';
import type { BatteryEfficiencyCycles, BatteryEfficiencyStore } from '../../lib/ports/batteryEfficiencyStore';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import { partialDouble } from '../helpers/partialDouble';

const STEP_MS = 10_000;
const START_MS = Date.UTC(2026, 10, 2, 0);

const memoryStore = (initial: BatteryEfficiencyCycles = new Map()) => {
  let rows = initial;
  const store: BatteryEfficiencyStore = {
    read: () => rows,
    write: (next) => { rows = next; },
  };
  return { store, rows: () => rows };
};

/**
 * A battery whose stored energy follows its AC power through its own charge and
 * discharge losses, reporting an integer level like a real battery.
 */
class SimulatedBattery {
  storedKWh: number;
  signedW = 0;
  available = true;
  managed = true;
  powerObservedAtMs = START_MS;
  /** While set, the battery keeps flowing but its power reading is not refreshed. */
  powerFrozen = false;

  constructor(
    private readonly capacityKWh: number,
    private readonly chargeEfficiency: number,
    private readonly dischargeEfficiency: number,
    startPercent: number,
  ) {
    this.storedKWh = capacityKWh * startPercent / 100;
  }

  get percent(): number {
    return Math.round(this.storedKWh / this.capacityKWh * 100);
  }

  advance(ms: number): void {
    const acKWh = this.signedW * ms / 3_600_000 / 1000;
    this.storedKWh += acKWh >= 0 ? acKWh * this.chargeEfficiency : acKWh / this.dischargeEfficiency;
  }

  /** One sample interval at the current power, reporting it unless the reading is frozen. */
  step(ms: number, nowMs: number): void {
    this.advance(ms);
    if (!this.powerFrozen) this.powerObservedAtMs = nowMs;
  }

  setPower(signedW: number): void {
    this.signedW = signedW;
  }

  surfaces(nowMs: number): DeviceSurfaces {
    return partialDouble<DeviceSurfaces>({
      id: 'battery', deviceClass: 'battery', managed: this.managed, available: this.available,
      batteryPower: { signedW: this.signedW, observedAtMs: Math.min(this.powerObservedAtMs, nowMs) },
      batteryLevel: { percent: this.percent, observedAtMs: nowMs },
    });
  }
}

const harness = (battery: SimulatedBattery, store = memoryStore()) => {
  let nowMs = START_MS;
  const learner = new BatteryEfficiencyLearner(store.store, () => [battery.surfaces(nowMs)]);
  const tick = (): void => {
    nowMs += STEP_MS;
    battery.step(STEP_MS, nowMs);
    learner.recordSample(nowMs);
  };
  learner.recordSample(nowMs);
  return {
    learner,
    store,
    /** Drive at `signedW` until the reported level reaches `percent`. */
    driveTo(percent: number, signedW: number): void {
      battery.setPower(signedW);
      for (let guard = 0; battery.percent !== percent; guard += 1) {
        if (guard > 100_000) throw new Error('battery never reached the level');
        tick();
      }
    },
    /** No meter sample for `ms` while the battery idles. */
    skip(ms: number): void {
      battery.setPower(0);
      nowMs += ms;
      battery.advance(ms);
    },
    tick,
  };
};

/** One full cycle: up to 80 %, down to 40 %, back up through the 51 % anchor. */
const cycle = (run: ReturnType<typeof harness>): void => {
  run.driveTo(80, 3000);
  run.driveTo(40, -3000);
  run.driveTo(51, 3000);
};

describe('battery round-trip efficiency measurement', () => {
  it('measures charge times discharge efficiency, capacity-independently, after three cycles', () => {
    const run = harness(new SimulatedBattery(13.5, 0.95, 0.9, 50));
    run.driveTo(51, 3000);
    cycle(run);
    expect(run.learner.read('battery')).toEqual({ status: 'measuring', cycles: 1, cyclesNeeded: 3 });
    cycle(run);
    cycle(run);
    const read = run.learner.read('battery');
    expect(read.status).toBe('measured');
    if (read.status !== 'measured') return;
    expect(read.cycles).toBe(3);
    expect(Math.abs(read.roundTripEfficiency - 0.95 * 0.9)).toBeLessThanOrEqual(0.01);
  });

  it('does not close a span whose level travelled less than the minimum excursion', () => {
    const run = harness(new SimulatedBattery(10, 0.95, 0.95, 50));
    run.driveTo(51, 2000);
    for (let i = 0; i < 4; i += 1) {
      run.driveTo(60, 2000);
      run.driveTo(45, -2000);
      run.driveTo(51, 2000);
    }
    expect(run.learner.read('battery')).toEqual({ status: 'measuring', cycles: 0, cyclesNeeded: 3 });
  });

  it('abandons the cycle in progress across a meter sample gap', () => {
    const run = harness(new SimulatedBattery(10, 0.95, 0.95, 50));
    run.driveTo(51, 3000);
    run.driveTo(80, 3000);
    run.skip(10 * 60_000);
    run.driveTo(40, -3000);
    run.driveTo(51, 3000);
    expect(run.learner.read('battery')).toEqual({ status: 'measuring', cycles: 0, cyclesNeeded: 3 });
    cycle(run);
    expect(run.learner.read('battery')).toEqual({ status: 'measuring', cycles: 1, cyclesNeeded: 3 });
  });

  it('abandons the cycle in progress when the battery reading is unavailable', () => {
    const battery = new SimulatedBattery(10, 0.95, 0.95, 50);
    const run = harness(battery);
    run.driveTo(51, 3000);
    run.driveTo(80, 3000);
    battery.available = false;
    run.tick();
    battery.available = true;
    run.driveTo(40, -3000);
    run.driveTo(51, 3000);
    expect(run.learner.read('battery')).toEqual({ status: 'measuring', cycles: 0, cyclesNeeded: 3 });
  });

  it('abandons the cycle when a flowing power reading stops being refreshed', () => {
    const battery = new SimulatedBattery(10, 0.95, 0.95, 50);
    const run = harness(battery);
    run.driveTo(51, 3000);
    battery.signedW = 3000;
    battery.powerFrozen = true;
    for (let i = 0; i < 100; i += 1) run.tick();
    battery.powerFrozen = false;
    run.driveTo(80, 3000);
    run.driveTo(40, -3000);
    run.driveTo(51, 3000);
    expect(run.learner.read('battery')).toEqual({ status: 'measuring', cycles: 0, cyclesNeeded: 3 });
  });

  it('rejects a cycle that returned more energy than it took in', () => {
    const run = harness(new SimulatedBattery(10, 1.1, 1, 50));
    run.driveTo(51, 3000);
    cycle(run);
    expect(run.learner.read('battery')).toEqual({ status: 'measuring', cycles: 0, cyclesNeeded: 3 });
  });

  it('ignores a battery that is not managed', () => {
    const battery = new SimulatedBattery(10, 0.95, 0.95, 50);
    battery.managed = false;
    const store = memoryStore();
    const run = harness(battery, store);
    run.driveTo(51, 3000);
    cycle(run);
    expect(store.rows().size).toBe(0);
  });

  it('suggests the median of the retained cycles and keeps only the latest five', () => {
    const store = memoryStore(new Map([['battery', [0.9, 0.7, 0.88, 0.86, 0.95]]]));
    const run = harness(new SimulatedBattery(10, 0.95, 0.95, 50), store);
    expect(run.learner.read('battery')).toEqual({ status: 'measured', roundTripEfficiency: 0.88, cycles: 5 });
    run.driveTo(51, 3000);
    cycle(run);
    const kept = store.rows().get('battery') ?? [];
    expect(kept).toHaveLength(5);
    expect(kept[0]).toBe(0.7);
  });

  it('answers unavailable while the store cannot be read, and writes nothing over it', () => {
    let writes = 0;
    const store: BatteryEfficiencyStore = {
      read: () => { throw new Error('disk'); },
      write: () => { writes += 1; },
    };
    const run = harness(new SimulatedBattery(10, 0.95, 0.95, 50), { store, rows: () => new Map() });
    expect(run.learner.read('battery')).toEqual({ status: 'unavailable' });
    run.driveTo(51, 3000);
    cycle(run);
    expect(writes).toBe(0);
  });
});
