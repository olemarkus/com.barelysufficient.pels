import CapacityGuard from '../../lib/power/capacityGuard';
import { PowerMeasurementGate } from '../../setup/powerMeasurementGate';

const WARN_AFTER_MS = 60_000;

// The real guard, not a stub: the gate's whole job is to report what the guard
// knows, and a hand-written double would be free to drift from it.
const buildGate = (guard: CapacityGuard | undefined, nowMs: () => number) => {
  const info = vi.fn();
  const warn = vi.fn();
  const gate = new PowerMeasurementGate({
    homeId: 'main',
    getCapacityGuard: () => guard,
    logger: () => ({ info, warn }) as never,
    warnAfterMs: WARN_AFTER_MS,
    nowMs,
    getPowerSource: () => 'homey_energy',
  });
  return { gate, info, warn };
};

describe('PowerMeasurementGate', () => {
  it('stays shut until the meter reports, then opens', () => {
    const guard = new CapacityGuard({ homeId: 'main', limitKw: 6 });
    const { gate, info } = buildGate(guard, () => 1000);

    expect(gate.isOpen()).toBe(false);
    expect(info).not.toHaveBeenCalled();

    guard.reportTotalPower(2.4);

    expect(gate.isOpen()).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'home_power_measurement_first_sample',
      homeId: 'main',
    }));
  });

  // A reading of exactly zero is a measurement — the house drawing nothing.
  // Treating it as absence would gate a home that is reporting perfectly.
  it('opens on a zero reading', () => {
    const guard = new CapacityGuard({ homeId: 'main', limitKw: 6 });
    const { gate } = buildGate(guard, () => 1000);

    guard.reportTotalPower(0);

    expect(gate.isOpen()).toBe(true);
  });

  it('warns once after the grace, not on every check', () => {
    const guard = new CapacityGuard({ homeId: 'main', limitKw: 6 });
    let nowMs = 1000;
    const { gate, warn } = buildGate(guard, () => nowMs);

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

  // An in-place meter swap puts the bundle back to "no reading from THIS meter",
  // which is the one way an open gate shuts again.
  it('re-gates after a meter swap and re-arms the warning', () => {
    const guard = new CapacityGuard({ homeId: 'main', limitKw: 6 });
    let nowMs = 1000;
    const { gate, warn, info } = buildGate(guard, () => nowMs);

    guard.reportTotalPower(2.4);
    expect(gate.isOpen()).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);

    guard.resetLastTotalPower();
    expect(gate.isOpen()).toBe(false);

    // The grace restarts from the swap, so the new meter gets its own window
    // rather than inheriting an already-expired one.
    nowMs += WARN_AFTER_MS - 1;
    gate.isOpen();
    expect(warn).not.toHaveBeenCalled();
    nowMs += 2;
    gate.isOpen();
    expect(warn).toHaveBeenCalledTimes(1);

    guard.reportTotalPower(1.1);
    expect(gate.isOpen()).toBe(true);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('stays shut when no guard is wired yet', () => {
    const { gate } = buildGate(undefined, () => 1000);

    expect(gate.isOpen()).toBe(false);
  });
});
