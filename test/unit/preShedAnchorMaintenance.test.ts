import {
  createInMemoryPreShedAnchorStore,
  maintainPreShedAnchors,
  type PreShedAnchorStore,
} from '../../lib/plan/preShedAnchor';
import { buildPlanDevice } from '../utils/planTestUtils';
import type { DevicePlanDevice } from '../../lib/plan/planTypes';

const shedDevice = (id: string, currentTarget: number, shedFloorC = 16): DevicePlanDevice =>
  buildPlanDevice({
    id,
    deviceType: 'temperature',
    plannedState: 'shed',
    shedAction: 'set_temperature',
    shedTemperature: shedFloorC,
    currentTarget,
    currentTemperature: currentTarget,
    plannedTarget: shedFloorC,
  });

const keptDevice = (id: string, currentTarget: number): DevicePlanDevice =>
  buildPlanDevice({
    id,
    deviceType: 'temperature',
    plannedState: 'keep',
    currentTarget,
    currentTemperature: currentTarget,
    plannedTarget: currentTarget,
  });

const anchorOf = (anchors: PreShedAnchorStore, id: string) => anchors.read(id);

describe('maintainPreShedAnchors', () => {
  it('captures the pre-shed setpoint on a setpoint-shed-posture build', () => {
    const anchors = createInMemoryPreShedAnchorStore();

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [shedDevice('heater', 21)],
      anchors,
    });

    expect(anchorOf(anchors, 'heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: 21, shedFloorC: 16 },
    });
  });

  it('never overwrites a live anchor while the device stays in posture', () => {
    // The first build after a restart holds the device already parked at its
    // shed floor — the persisted anchor is the truth there and must win over
    // the observed (shed) setpoint.
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('heater', { anchorC: 21, shedFloorC: 16 });

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [shedDevice('heater', 16)],
      anchors,
    });

    expect(anchorOf(anchors, 'heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: 21, shedFloorC: 16 },
    });
  });

  it('captures a posture build whose setpoint is still off-floor even without a shed-set edge', () => {
    // The behaviour-flip case: a thermostat already in the generic shed set as
    // `turn_off` whose behaviour becomes `set_temperature` mid-hold enters
    // setpoint posture with NO shed-set edge — capture must not depend on one.
    const anchors = createInMemoryPreShedAnchorStore();

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [shedDevice('heater', 21)],
      anchors,
    });

    expect(anchorOf(anchors, 'heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: 21, shedFloorC: 16 },
    });
  });

  it('keeps the anchor while a released device is still parked at the floor', () => {
    // The release write has not landed yet: the debt stands, so the seed keeps
    // demanding the anchor on every build until the device actually moves.
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('heater', { anchorC: 21, shedFloorC: 16 });

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [keptDevice('heater', 16)],
      anchors,
    });

    expect(anchorOf(anchors, 'heater').kind).toBe('anchored');
  });

  it('clears once a released device converges onto the anchor', () => {
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('heater', { anchorC: 21, shedFloorC: 16 });

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [keptDevice('heater', 21)],
      anchors,
    });

    expect(anchorOf(anchors, 'heater')).toEqual({ kind: 'none' });
  });

  it('clears when a released device was moved somewhere else entirely', () => {
    // A person (or another app) chose a different setpoint after release: the
    // live value is the truth again; keeping the anchor would revert them.
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('heater', { anchorC: 21, shedFloorC: 16 });

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [keptDevice('heater', 18.5)],
      anchors,
    });

    expect(anchorOf(anchors, 'heater')).toEqual({ kind: 'none' });
  });

  it('clears a degenerate anchor (intent equals the floor) on release', () => {
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('heater', { anchorC: 16, shedFloorC: 16 });

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [keptDevice('heater', 16)],
      anchors,
    });

    expect(anchorOf(anchors, 'heater')).toEqual({ kind: 'none' });
  });

  it('skips capture and re-pin when captureEnabled is false, but still settles on observation', () => {
    // Dry-run posture: a simulated shed persists no debt, but a released
    // device observed away from its pinned floor still settles — observations
    // are real-world facts whether or not PELS is actuating.
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('released', { anchorC: 21, shedFloorC: 16 });

    maintainPreShedAnchors({
      captureEnabled: false,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [shedDevice('entering', 21), keptDevice('released', 21)],
      anchors,
    });

    expect(anchorOf(anchors, 'entering')).toEqual({ kind: 'none' });
    expect(anchorOf(anchors, 'released')).toEqual({ kind: 'none' });
  });

  it('retains the anchor of an uncontrolled device still parked at the floor', () => {
    // Capacity control turned off at the decision edge, while the device
    // still reports the floor: the seed has already planned the anchored
    // target, and if that write fails (or the process dies) the next build
    // must still know the debt. Clearing here used to strand the device.
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('heater', { anchorC: 21, shedFloorC: 16 });
    const uncontrolled = { ...keptDevice('heater', 16), controllable: false };

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [uncontrolled],
      anchors,
    });

    expect(anchorOf(anchors, 'heater').kind).toBe('anchored');
  });

  it('clears an uncontrolled device once observation confirms the setpoint left the floor', () => {
    // The owner's own retarget (or the landed release write) is the
    // observation-confirmed moment the debt settles — same rule as a
    // released device, so capacity-off cannot strand a parked device.
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('heater', { anchorC: 21, shedFloorC: 16 });
    const uncontrolled = { ...keptDevice('heater', 20), controllable: false };

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [uncontrolled],
      anchors,
    });

    expect(anchorOf(anchors, 'heater')).toEqual({ kind: 'none' });
  });

  it('leaves anchors of devices absent from the plan untouched', () => {
    // A transient snapshot gap (or an unmanage mid-episode) must not settle
    // the debt — the entry waits for the device to re-appear.
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('gone', { anchorC: 21, shedFloorC: 16 });

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [keptDevice('heater', 20)],
      anchors,
    });

    expect(anchorOf(anchors, 'gone').kind).toBe('anchored');
  });

  it('does not capture for a temperature device shed by turn_off', () => {
    // A binary shed leaves the setpoint intact — there is no setpoint debt.
    const anchors = createInMemoryPreShedAnchorStore();
    const device = buildPlanDevice({
      id: 'onoff-thermostat',
      deviceType: 'temperature',
      plannedState: 'shed',
      shedAction: 'turn_off',
      currentTarget: 21,
      currentTemperature: 21,
      plannedTarget: 21,
    });

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [device],
      anchors,
    });

    expect(anchorOf(anchors, 'onoff-thermostat')).toEqual({ kind: 'none' });
  });

  it('skips a degenerate capture (pre-shed setpoint already at the floor)', () => {
    // Upgrade-boot / post-abandon re-decide of an already-shed device: the
    // observed setpoint IS the floor, so a capture would record no debt — and
    // would let the seeder label a shed floor `pre_shed_anchor`. No anchor
    // means both consumers honestly fall back to the live value.
    const anchors = createInMemoryPreShedAnchorStore();

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [shedDevice('heater', 16, 16)],
      anchors,
    });

    expect(anchorOf(anchors, 'heater')).toEqual({ kind: 'none' });
  });

  it('keeps the old floor pin until the device is observed at the edited floor', () => {
    // The owner edited the floor 16 -> 14 mid-hold, but the write to 14 has
    // not landed: the device still reports 16. Re-pinning early would make
    // the at-floor gate miss the device it still describes — a release in
    // that window would clear the anchor while the device is parked.
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('heater', { anchorC: 21, shedFloorC: 16 });

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [shedDevice('heater', 16, 14)],
      anchors,
    });

    expect(anchorOf(anchors, 'heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: 21, shedFloorC: 16 },
    });
  });

  it('re-pins the floor once the device is observed at the edited floor', () => {
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('heater', { anchorC: 21, shedFloorC: 16 });

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [shedDevice('heater', 14, 14)],
      anchors,
    });

    expect(anchorOf(anchors, 'heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: 21, shedFloorC: 14 },
    });
  });

  it('keeps the anchor when a released device sits at the CURRENT configured floor (edit landing)', () => {
    // The coinciding edit+release build: the floor edit's write landed this
    // build (observed 17), but the pin still names the old floor (16.5) —
    // maintenance has not re-pinned yet. Recognizing only the pinned floor
    // read this as a manual move and cleared the debt while parked.
    const anchors = createInMemoryPreShedAnchorStore();
    anchors.record('heater', { anchorC: 21, shedFloorC: 16.5 });

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map([['heater', 17]]),
      planDevices: [keptDevice('heater', 17)],
      anchors,
    });

    expect(anchorOf(anchors, 'heater')).toEqual({
      kind: 'anchored',
      entry: { anchorC: 21, shedFloorC: 16.5 },
    });
  });

  it('still captures a decision edge while the store answers unavailable, and never clears', () => {
    // Transient adapter grace: clearing would be a decision, so it never
    // happens — but a fresh shed decision's capture IS forwarded, because the
    // store contract makes a record during the grace a deferred
    // record-if-absent (a recovered persisted anchor still wins).
    const calls: string[] = [];
    const unavailable: PreShedAnchorStore = {
      read: () => ({ kind: 'unavailable' }),
      record: (deviceId) => {
        calls.push(`record:${deviceId}`);
      },
      clear: (deviceId) => {
        calls.push(`clear:${deviceId}`);
      },
      retryDirtyPersist: () => undefined,
    };

    maintainPreShedAnchors({
      captureEnabled: true,
      normalizedShedFloorCByDevice: new Map(),
      planDevices: [shedDevice('entering', 21), keptDevice('released', 16)],
      anchors: unavailable,
    });

    expect(calls).toEqual(['record:entering']);
  });
});
