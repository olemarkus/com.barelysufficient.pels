import type { PowerTrackerState } from '../../lib/power/tracker';
import { PowerMeasurementGate } from '../../lib/power/powerMeasurementGate';

const WARN_AFTER_MS = 60_000;

// Driven through the real tracker state, not a stub: the gate's whole job is to
// report whether that latch holds a reading, and a hand-written double would be
// free to drift from it.
const buildGate = (tracker: PowerTrackerState, nowMs: () => number) => {
  const info = vi.fn();
  const warn = vi.fn();
  const gate = new PowerMeasurementGate({
    homeId: 'main',
    getPowerTracker: () => tracker,
    logger: () => ({ info, warn }) as never,
    warnAfterMs: WARN_AFTER_MS,
    nowMs,
    getPowerSource: () => ({ state: 'resolved', value: 'homey_energy' }),
  });
  return { gate, info, warn };
};

describe('PowerMeasurementGate', () => {
  it('stays shut until the meter reports, then opens', () => {
    const tracker: PowerTrackerState = {};
    const { gate, info } = buildGate(tracker, () => 1000);

    expect(gate.isOpen()).toBe(false);
    expect(info).not.toHaveBeenCalled();

    tracker.lastPowerW = 2400;
    tracker.lastTimestamp = Date.now();

    expect(gate.isOpen()).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_power_measurement_first_sample',
      homeId: 'main',
    }));
  });

  // A reading of exactly zero is a measurement — the house drawing nothing.
  // Treating it as absence would gate a home that is reporting perfectly.
  it('opens on a zero reading', () => {
    const tracker: PowerTrackerState = {};
    const { gate } = buildGate(tracker, () => 1000);

    tracker.lastPowerW = 0;
    tracker.lastTimestamp = Date.now();

    expect(gate.isOpen()).toBe(true);
  });

  // A junk latch is not a measurement. The resolver gates finiteness at the
  // read, so the gate never opens on a value nothing downstream could use.
  it('stays shut on a non-finite reading', () => {
    const tracker: PowerTrackerState = { lastPowerW: Number.NaN };
    const { gate } = buildGate(tracker, () => 1000);

    expect(gate.isOpen()).toBe(false);
  });

  it('warns once after the grace, not on every check', () => {
    const tracker: PowerTrackerState = {};
    let nowMs = 1000;
    const { gate, warn } = buildGate(tracker, () => nowMs);

    gate.isOpen();
    nowMs += WARN_AFTER_MS - 1;
    gate.isOpen();
    expect(warn).not.toHaveBeenCalled();

    nowMs += 2;
    gate.isOpen();
    gate.isOpen();
    gate.isOpen();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_bundle_gated_no_power_sample',
      homeId: 'main',
      // Names the configured source: the flow-specific cause is wrong for a
      // Homey Energy home, and this line is the operator's only diagnostic.
      powerSource: 'homey_energy',
      detail: expect.stringContaining('whole-home meter is not reporting'),
    }));
  });

  // An in-place meter swap clears the tracker latch
  // (`HomeTrackerPersistence.resetFreshness`), which is the one way an open
  // gate shuts again.
  it('re-gates after a meter swap and re-arms the warning', () => {
    const tracker: PowerTrackerState = {};
    let nowMs = 1000;
    const { gate, warn, info } = buildGate(tracker, () => nowMs);

    tracker.lastPowerW = 2400;
    tracker.lastTimestamp = Date.now();
    expect(gate.isOpen()).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);

    tracker.lastPowerW = undefined;
    tracker.lastTimestamp = undefined;
    expect(gate.isOpen()).toBe(false);

    // The grace restarts from the swap, so the new meter gets its own window
    // rather than inheriting an already-expired one.
    nowMs += WARN_AFTER_MS - 1;
    gate.isOpen();
    expect(warn).not.toHaveBeenCalled();
    nowMs += 2;
    gate.isOpen();
    expect(warn).toHaveBeenCalledTimes(1);

    tracker.lastPowerW = 1100;
    tracker.lastTimestamp = Date.now();
    expect(gate.isOpen()).toBe(true);
    expect(info).toHaveBeenCalledTimes(2);
  });
});
