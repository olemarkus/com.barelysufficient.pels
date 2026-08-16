import { PowerFreshnessMonitor } from '../../lib/power/powerCycleReading';
import {
  POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  POWER_SAMPLE_STALE_THRESHOLD_MS,
} from '../../lib/power/sampleFreshness';

const NOW_MS = Date.UTC(2026, 3, 18, 10, 0, 0);

const buildLog = () => ({ info: vi.fn(), warn: vi.fn() });

const observe = (
  monitor: PowerFreshnessMonitor,
  ageMs: number | null,
  totalKw: number | null = 4,
) => monitor.observe({
  powerTracker: ageMs === null ? {} : { lastTimestamp: NOW_MS - ageMs },
  totalKw,
  nowMs: NOW_MS,
});

/**
 * A monitor that has already been watching for the full timeout, so the restart
 * grace is spent and an aged sample escalates. Tests about the LADDER want this;
 * tests about the grace itself build a fresh monitor (see that describe block).
 */
const watchingMonitor = (structuredLog?: ReturnType<typeof buildLog>) => {
  const monitor = new PowerFreshnessMonitor(structuredLog);
  monitor.observe({
    powerTracker: {},
    totalKw: null,
    nowMs: NOW_MS - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
  });
  // The warm-up itself is a null -> stale_hold transition and logs one line;
  // clear it so assertions below count only the transition under test.
  structuredLog?.info.mockClear();
  structuredLog?.warn.mockClear();
  return monitor;
};

describe('PowerFreshnessMonitor — what the planner is allowed to know', () => {
  it('answers a measured headroom as the real difference', () => {
    const reading = observe(new PowerFreshnessMonitor(), 1000, 4);

    expect(reading.isMeasured).toBe(true);
    expect(reading.headroomKw(6)).toBeCloseTo(2, 6);
    expect(reading.headroomKw(3)).toBeCloseTo(-1, 6);
  });

  // The two synthesized values are the whole point of the seam: a held cycle
  // admits nothing, a fail-closed one sheds. Neither is a measurement, and the
  // planner cannot tell them apart from a real difference.
  it('holds at 0 before the shed timeout and forces -1 after it', () => {
    const held = observe(new PowerFreshnessMonitor(), POWER_SAMPLE_STALE_THRESHOLD_MS, 4);
    expect(held.isMeasured).toBe(false);
    expect(held.headroomKw(6)).toBe(0);
    expect(held.headroomKw(0)).toBe(0);

    const failClosed = observe(watchingMonitor(), POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, 4);
    expect(failClosed.isMeasured).toBe(false);
    expect(failClosed.headroomKw(6)).toBe(-1);
    expect(failClosed.headroomKw(0)).toBe(-1);
  });

  // A cached total the meter has stopped confirming must not be spendable.
  it('never spends a stale total, however large', () => {
    const reading = observe(new PowerFreshnessMonitor(), POWER_SAMPLE_STALE_THRESHOLD_MS, 9.9);

    expect(reading.headroomKw(6)).toBe(0);
    expect(reading.measuredAtOrBelowKw(100)).toBe(false);
  });

  it('reports no measurement when there is no total, even on a fresh timestamp', () => {
    const reading = observe(new PowerFreshnessMonitor(), 1000, null);

    expect(reading.isMeasured).toBe(false);
    expect(reading.headroomKw(6)).toBe(0);
    expect(reading.measuredAtOrBelowKw(100)).toBe(false);
  });

  it('answers measuredAtOrBelowKw only on a positive measurement', () => {
    const reading = observe(new PowerFreshnessMonitor(), 1000, 4);

    expect(reading.measuredAtOrBelowKw(4)).toBe(true);
    expect(reading.measuredAtOrBelowKw(4.0001)).toBe(true);
    expect(reading.measuredAtOrBelowKw(3.9999)).toBe(false);
  });

  it('resolves the measured draw once, rather than leaving consumers to recombine it', () => {
    const measured = observe(new PowerFreshnessMonitor(), 1000, 1.85);
    expect(measured.display.measuredTotalKw).toBeCloseTo(1.85, 10);

    // Held: the raw reading is still there for display, but the planning figure
    // is absent — the two must not be the same field.
    const held = observe(new PowerFreshnessMonitor(), POWER_SAMPLE_STALE_THRESHOLD_MS, 1.85);
    expect(held.display.totalKw).toBeCloseTo(1.85, 10);
    expect(held.display.measuredTotalKw).toBeNull();
  });
});

describe('PowerFreshnessMonitor — the restart grace', () => {
  // `lastTimestamp` survives a restart (`loadPowerTrackerState`), so without this
  // the first build after any reboot longer than the timeout would resolve
  // fail-closed and shed the whole house blind, before the first poll landed.
  it('holds instead of escalating when the aged sample predates this monitor', () => {
    const monitor = new PowerFreshnessMonitor();

    const atBoot = monitor.observe({
      powerTracker: { lastTimestamp: NOW_MS - (POWER_SAMPLE_STALE_SHED_TIMEOUT_MS * 3) },
      totalKw: 4,
      nowMs: NOW_MS,
    });

    expect(atBoot.isMeasured).toBe(false);
    expect(atBoot.headroomKw(6)).toBe(0);
  });

  it('escalates once it has watched for the full timeout without a sample', () => {
    const monitor = new PowerFreshnessMonitor();
    const staleTracker = { lastTimestamp: NOW_MS - (POWER_SAMPLE_STALE_SHED_TIMEOUT_MS * 3) };

    monitor.observe({ powerTracker: staleTracker, totalKw: 4, nowMs: NOW_MS });
    const justShort = monitor.observe({
      powerTracker: staleTracker,
      totalKw: 4,
      nowMs: NOW_MS + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - 1,
    });
    expect(justShort.headroomKw(6)).toBe(0);

    const escalated = monitor.observe({
      powerTracker: staleTracker,
      totalKw: 4,
      nowMs: NOW_MS + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
    });
    expect(escalated.headroomKw(6)).toBe(-1);
  });

  // A sample that arrives during the grace is the normal recovery, and must not
  // have to wait the grace out.
  it('goes measured the moment a real sample lands inside the grace', () => {
    const monitor = new PowerFreshnessMonitor();

    monitor.observe({
      powerTracker: { lastTimestamp: NOW_MS - (POWER_SAMPLE_STALE_SHED_TIMEOUT_MS * 3) },
      totalKw: 4,
      nowMs: NOW_MS,
    });
    const recovered = monitor.observe({
      powerTracker: { lastTimestamp: NOW_MS + 5_000 },
      totalKw: 4,
      nowMs: NOW_MS + 5_000,
    });

    expect(recovered.isMeasured).toBe(true);
    expect(recovered.headroomKw(6)).toBeCloseTo(2, 6);
  });

  // A home that has never sampled has no age to escalate on and already held;
  // the grace must not turn that into an escalation later.
  it('leaves a never-sampled home holding, not escalating', () => {
    const monitor = new PowerFreshnessMonitor();

    monitor.observe({ powerTracker: {}, totalKw: null, nowMs: NOW_MS });
    const later = monitor.observe({
      powerTracker: {},
      totalKw: null,
      nowMs: NOW_MS + (POWER_SAMPLE_STALE_SHED_TIMEOUT_MS * 5),
    });

    expect(later.headroomKw(6)).toBe(0);
  });
});

describe('PowerFreshnessMonitor — transition logs', () => {
  it('logs a state only on the transition into it, not every cycle', () => {
    const structuredLog = buildLog();
    const monitor = new PowerFreshnessMonitor(structuredLog);

    observe(monitor, POWER_SAMPLE_STALE_THRESHOLD_MS);
    observe(monitor, POWER_SAMPLE_STALE_THRESHOLD_MS + 1);
    observe(monitor, POWER_SAMPLE_STALE_THRESHOLD_MS + 2);

    expect(structuredLog.warn).toHaveBeenCalledTimes(1);
    expect(structuredLog.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_sample_stale_hold_entered',
      syntheticHeadroomKw: 0,
    }));
  });

  // The two ladders are INDEPENDENT. Collapsing them into one else-if chain
  // silently drops the hold's `_cleared` line on this exact step, which is the
  // one a log reader uses to see the escalation.
  it('emits BOTH the hold clear and the fail-closed entry on an escalation', () => {
    const structuredLog = buildLog();
    const monitor = watchingMonitor(structuredLog);

    observe(monitor, POWER_SAMPLE_STALE_THRESHOLD_MS);
    structuredLog.warn.mockClear();
    observe(monitor, POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_sample_stale_hold_cleared',
    }));
    expect(structuredLog.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_sample_stale_fail_closed_entered',
      syntheticHeadroomKw: -1,
    }));
  });

  it('clears fail-closed once a sample returns', () => {
    const structuredLog = buildLog();
    const monitor = watchingMonitor(structuredLog);

    observe(monitor, POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
    observe(monitor, 0);

    expect(structuredLog.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'power_sample_stale_fail_closed_cleared',
    }));
  });

  // Per home: a shared monitor would let one home's escalation suppress
  // another's log, and meter areas escalate independently of the main home.
  it('keeps separate histories per instance', () => {
    const firstLog = buildLog();
    const secondLog = buildLog();
    const first = watchingMonitor(firstLog);
    const second = watchingMonitor(secondLog);

    observe(first, POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
    observe(second, POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);

    expect(firstLog.warn).toHaveBeenCalledTimes(1);
    expect(secondLog.warn).toHaveBeenCalledTimes(1);
  });

  it('works without a logger wired', () => {
    const monitor = watchingMonitor();

    expect(() => observe(monitor, POWER_SAMPLE_STALE_SHED_TIMEOUT_MS)).not.toThrow();
  });
});
