import type {
  BinaryControlDiscriminantProbe,
  PlanInputDevice,
} from '../../lib/plan/planTypes';
import type { ObservedDeviceState } from '../../packages/contracts/src/types';
import { buildPlanInputDevice } from '../utils/planTestUtils';

describe('buildPlanInputDevice', () => {
  it('keeps availability and controllability required at both producer seams', () => {
    expectTypeOf<ObservedDeviceState>().toMatchTypeOf<{ available: boolean }>();
    expectTypeOf<PlanInputDevice>().toMatchTypeOf<{
      available: boolean;
      controllable: boolean;
    }>();
  });

  it('emits exactly the shape the producer emits for an undescribed device', () => {
    const device = buildPlanInputDevice({ id: 'dev-1' });

    // Exhaustive on purpose: this is the parity pin for the ONE shared builder.
    // A second builder used to live in `test/helpers/`, and its cast shipped a
    // shape `toPlanDevice` cannot emit — four required booleans missing, the raw
    // `binaryControl` kept, `currentOn` never stamped. `hasStandingDemand:
    // undefined` is the first gate in starvation detection and surplus absorb,
    // so no device that builder produced could ever be seen as starved.
    expect(device).toEqual({
      controllable: true,
      available: true,
      id: 'dev-1',
      name: 'Device',
      targets: [],
      // Required base field — resolved the way the producer resolves it, never
      // left undefined for a consumer to read as "not commandable".
      commandableNow: true,
      // The producer's two boost bits, resolved from the (absent) config and
      // readings this fixture spells.
      boostSupported: false,
      boostRequested: false,
      // Everything but a charger is going without when it is off — the
      // producer's `!isEvObserved(device)`.
      hasStandingDemand: true,
      // Producer-required two-state bit; `false` is "no calibration opinion".
      confirmedNotDrawing: false,
      // Required since #2182: the producer answers "is there a creditable
      // session" for every device, and only an EV charger can lack one. A
      // non-EV fixture is never session-inactive.
      objectiveSessionInactive: false,
      // The producer's resolved on/off truth and four-valued label. The RAW
      // `binaryControl` is stripped, exactly as `toPlanDevice` strips it.
      currentOn: true,
      currentState: 'on',
      // Likewise required: a plan device always carries a resolved draw. This
      // fixture declares no power at all, and the producer answers 0 for a device
      // nobody described — it no longer invents a generic 1 kW.
      currentDrawKw: 0,
      // Both halves resolved by the producer itself
      // (`buildResidualKwForPlanDevice`). A device drawing nothing frees nothing
      // by being shed; restoring it costs whatever it draws when running, which
      // for an undescribed device is the estimator's last rung.
      residualKw: { shed: 0, restore: { kw: 1, source: 'expected' } },
      // The draw-when-running twin, also required. Unlike `currentDrawKw` this
      // one DOES end on a fallback: "draws nothing when running" is not an answer,
      // so the ladder resolves the 1 kW default rather than absence.
      expectedPowerKw: 1,
      // Which rung produced that number — required alongside it, so absence is
      // not a state any consumer can observe. A fixture nobody described lands
      // on the same last rung the 1 kW above came from.
      expectedPowerSource: 'default',
    });
  });

  it('lets overrides win over the defaults', () => {
    const overrides: Partial<PlanInputDevice> & { id: string } & BinaryControlDiscriminantProbe = {
      id: 'dev-2',
      name: 'Living room heater',
      binaryControl: { on: false },
    };
    const device = buildPlanInputDevice(overrides);

    expect(device.id).toBe('dev-2');
    expect(device.name).toBe('Living room heater');
    // The raw observed axis is resolved into `currentOn` and stripped, the way
    // the producer resolves and strips it.
    expect((device as PlanInputDevice & { currentOn: boolean }).currentOn).toBe(false);
    expect(device).not.toHaveProperty('binaryControl');
    expect(device.targets).toEqual([]);
  });

  it('preserves explicit unavailable and uncontrollable states', () => {
    const device = buildPlanInputDevice({
      id: 'dev-unreachable',
      available: false,
      controllable: false,
    });

    expect(device.available).toBe(false);
    expect(device.controllable).toBe(false);
  });

  it('passes through optional fields unchanged and leaves unspecified ones undefined', () => {
    const device = buildPlanInputDevice({
      id: 'dev-3',
      deviceClass: 'evcharger',
      currentOn: true,
      priority: 4,
      expectedPowerKw: 7.2,
      objectiveKind: 'ev_soc',
    });

    expect(device.deviceClass).toBe('evcharger');
    expect((device as PlanInputDevice & { currentOn: boolean }).currentOn).toBe(true);
    expect(device.priority).toBe(4);
    expect(device.expectedPowerKw).toBe(7.2);
    expect(device.objectiveKind).toBe('ev_soc');
    // A charger's demand arrives with a car, not with the setpoint — the
    // producer's one standing-demand rule, mirrored.
    expect(device.hasStandingDemand).toBe(false);
  });

  it('replaces the default targets array when an override is supplied', () => {
    const targets: PlanInputDevice['targets'] = [
      { id: 'target_temperature', unit: 'C', value: 65 },
    ];

    const device = buildPlanInputDevice({ id: 'dev-4', targets });

    expect(device.targets).toBe(targets);
  });
});
