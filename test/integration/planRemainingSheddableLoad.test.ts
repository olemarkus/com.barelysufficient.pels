import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import {
  resolveRemainingSheddableLoadKw,
  sumRemainingSheddableLoadKw,
  toInputRemainingSheddableDevice,
  toPlanRemainingSheddableDevice,
} from '../../lib/plan/planRemainingSheddableLoad';
import {
  resolveResidualKwShed,
  type ResidualKwShedBehavior,
} from '../../lib/device/deviceResidualKw';
import {
  normalizeSteppedLoadStepStateFromLegacyFields,
  resolveKnownEffectiveStepId,
} from '../../lib/plan/planSteppedLoadState';
import { getPrimaryTargetCapability } from '../../lib/utils/targetCapabilities';
import {
  buildPlanDevice as baseBuildPlanDevice,
  buildPlanInputDevice as baseBuildPlanInputDevice,
  steppedProfile,
  withFixtureResidualKw,
} from '../utils/planTestUtils';
import {
  type BinaryControlDiscriminantProbe,
  type DevicePlanDevice,
  type PlanInputDevice,
  type SteppedDiscriminantProbe,
  withBinaryDiscriminant,
} from '../../lib/plan/planTypes';
import { isBinaryPlanDevice } from '../../lib/plan/planBinaryDevice';
import { isTemperaturePlanDevice } from '../../lib/plan/planTemperatureDevice';

// Local wrappers that route a `binaryControl` override through the binary
// discriminant regrouper — the field moved off the base device types onto the
// orthogonal binary cluster, so the shared builders no longer accept it flat.
const buildPlanDevice = (
  overrides: Parameters<typeof baseBuildPlanDevice>[0] & BinaryControlDiscriminantProbe = {},
): DevicePlanDevice => {
  const { binaryControl, ...rest } = overrides;
  return withBinaryDiscriminant({
    ...baseBuildPlanDevice(rest),
    ...(binaryControl !== undefined ? { binaryControl } : {}),
  }) as DevicePlanDevice;
};

const buildPlanInputDevice = (
  overrides: Parameters<typeof baseBuildPlanInputDevice>[0] & BinaryControlDiscriminantProbe = {},
): PlanInputDevice => {
  const { binaryControl, ...rest } = overrides;
  return withBinaryDiscriminant({
    ...baseBuildPlanInputDevice(rest),
    ...(binaryControl !== undefined ? { binaryControl } : {}),
  }) as PlanInputDevice;
};

describe('resolveRemainingSheddableLoadKw — stale observation handling', () => {

  it('credits a still-drawing unknown-state device its measured draw', () => {
    // A device whose observer label is 'unknown' carries no confirmed-off
    // `currentOn`, so it must NOT be silently zeroed out of remaining sheddable
    // load — that would mis-signal "no actionable load left" during shortfall.
    //
    // "Is it still drawing?" is no longer a guess: the meter answers it. This one
    // reads 1.4 kW, so shedding it frees 1.4 kW. (The spec used to credit the
    // CONFIGURED demand for an unknown device with a measured 0 — the invented
    // substitution this change removes. The confirmed-off case is the sibling
    // spec below.)
    const unknown = toPlanRemainingSheddableDevice(buildPlanDevice({
      id: 'unknown-off',
      controllable: true,
      binaryControl: { on: false },
      currentState: 'unknown',
      measuredPowerKw: 1.4, expectedPowerKw: 1.4,
    }));
    const kw = resolveRemainingSheddableLoadKw({
      device: unknown,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    });
    expect(kw).toBeCloseTo(1.4, 6);
  });

  it('returns 0 for a confirmed currentOn=false device — shedding gives no immediate relief', () => {
    const fresh = toPlanRemainingSheddableDevice(buildPlanDevice({
      id: 'fresh-off',
      controllable: true,
      binaryControl: { on: false },
      currentState: 'off',
      measuredPowerKw: 0, expectedPowerKw: 1.4,
    }));
    const kw = resolveRemainingSheddableLoadKw({
      device: fresh,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    });
    expect(kw).toBe(0);
  });
});

describe('sumRemainingSheddableLoadKw — producer-resolved residual', () => {
  // The consumer reads `residualKw.shed` and nothing else. These cascades pin
  // the absolute totals the producer's values must sum to; the per-device
  // adversarial test below pins each value in isolation so a refactor cannot
  // satisfy the cascade vacuously.

  it('sums a representative mixed cascade from the producer values', () => {
    const simpleOn = buildPlanInputDevice({
      id: 'simple-on',
      controllable: true,
      binaryControl: { on: true },
      currentState: 'on',
      measuredPowerKw: 1.4,
    });
    const steppedMax = buildPlanInputDevice({
      id: 'stepped-max',
      controllable: true,
      binaryControl: { on: true },
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'max',
      binaryCapabilityId: 'onoff',
      measuredPowerKw: 2.9,
    });
    const steppedAtLowestActive = buildPlanInputDevice({
      id: 'stepped-low',
      controllable: true,
      binaryControl: { on: true },
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      binaryCapabilityId: 'onoff',
      measuredPowerKw: 1.2,
    });

    // Populate residualKw with what the producer emits for a turn_off shed.
    // The shape mirrors `toPlanDevice` in `setup/appInit.ts`.
    const producerDevices = [
      withFixtureResidualKw({ ...simpleOn, residualKw: { shed: 1.4 } }),
      withFixtureResidualKw({ ...steppedMax, residualKw: { shed: 2.9 } }),
      // Already at lowest active + has binary control → producer says it can
      // still shed via the binary capability.
      withFixtureResidualKw({ ...steppedAtLowestActive, residualKw: { shed: 1.2 } }),
    ].map(toInputRemainingSheddableDevice);
    const producerTotal = sumRemainingSheddableLoadKw({
      devices: producerDevices,
      isAlreadyShed: () => false,
      limitSource: 'capacity',
      capacityBreached: true,
    });

    expect(producerTotal).toBeCloseTo(1.4 + 2.9 + 1.2, 6);
  });

  // Edge-case cascade-parity coverage added 2026-05-27.
  //
  // Edge cases the producer-resolved path handles.
  // The former cases (b) and (c) — a stepped device with `selectedStepId`
  // absent — are unrepresentable now that the producer refuses a stepped
  // cluster without its effective step, so only the representable cases stay:
  //   (a) Stepped, `binaryCapabilityId: undefined`, already at the lowest active
  //       step. With selectedStepId set, both paths see a target step
  //       different from the current step → both report residual = measured
  //       draw. (The binary-finish gate that would zero this out only fires
  //       when the target step ID equals the current step ID.)
  //   (d) Temperature device with `currentValue == normalized shedTemperature`.
  //       Both paths reject the shed via `canStillShedTemperature` → 0.
  it('sums the edge cases (a, d) from the producer values', () => {
    // The cascade also includes a positive-residual baseline (steppedMax) so
    // the watt-equality assertion has something non-zero to anchor on.
    const baselineSteppedMax = buildPlanInputDevice({
      id: 'baseline-stepped-max',
      controllable: true,
      binaryControl: { on: true },
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'max',
      binaryCapabilityId: 'onoff',
      measuredPowerKw: 2.9,
    });

    // (a) Stepped, no binary control, already at the lowest active step.
    const steppedLowestNoBinary = buildPlanInputDevice({
      id: 'edge-a-stepped-lowest-no-binary',
      controllable: true,
      binaryControl: { on: true },
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      binaryCapabilityId: undefined,
      measuredPowerKw: 1.2,
    });

    // (d) Temperature device with `currentValue == normalized shedTemperature`.
    //     `canStillShedTemperature` returns false; residual = 0.
    const temperatureNoopShed = buildPlanInputDevice({
      id: 'edge-d-temperature-noop',
      controllable: true,
      binaryControl: { on: true },
      currentState: 'on',
      measuredPowerKw: 1.4,
      targets: [{
        id: 'target_temperature',
        value: 18,
        unit: '°C',
        min: 5,
        max: 30,
        step: 0.5,
      }],
    });


    const fixtures = [
      baselineSteppedMax,
      steppedLowestNoBinary,
      temperatureNoopShed,
    ];

    // Populate `residualKw.shed` using the same
    // resolver wired by `setup/appInit/residualKwForPlanDevice.ts`. We
    // compute it inline rather than importing the wiring helper because the
    // helper takes a `TargetDeviceSnapshot`, not a `PlanInputDevice`.
    const producerDevices = fixtures.map((device): PlanInputDevice => {
      // `steppedLoadProfile` lives on the stepped discriminant cluster; widen a
      // local probe view to read it without re-adding the field to the base type.
      const steppedDevice = device as PlanInputDevice & SteppedDiscriminantProbe;
      const shedBehavior: ResidualKwShedBehavior = device.id === temperatureNoopShed.id
        ? { action: 'set_temperature', temperature: 18 }
        : { action: 'turn_off' };
      const stepState = device.controlModel === 'stepped_load' && steppedDevice.steppedLoadProfile
        ? normalizeSteppedLoadStepStateFromLegacyFields({
          fields: device,
          selectedStepFallbackIsPlanningAssumption: true,
        })
        : null;
      const target = getPrimaryTargetCapability(device.targets);
      const shed = resolveResidualKwShed({
        device: {
          currentDrawKw: device.currentDrawKw,
          ...(target
            ? {
              temperatureTarget: {
                ...(typeof target.value === 'number' && Number.isFinite(target.value)
                  ? { currentValue: target.value }
                  : {}),
                ...(typeof target.min === 'number' && Number.isFinite(target.min) ? { min: target.min } : {}),
                ...(typeof target.max === 'number' && Number.isFinite(target.max) ? { max: target.max } : {}),
                ...(typeof target.step === 'number' && Number.isFinite(target.step) ? { step: target.step } : {}),
              },
            }
            : {}),
          ...(device.controlModel === 'stepped_load' && steppedDevice.steppedLoadProfile && stepState
            ? {
              steppedLoad: {
                profile: steppedDevice.steppedLoadProfile,
                ...(isSteppedLoadDevice(device) ? { selectedStepId: device.selectedStepId } : {}),
                hasKnownEffectiveStep: resolveKnownEffectiveStepId(stepState) !== undefined,
                currentDrawKw: device.currentDrawKw,
                hasBinaryControl: isBinaryPlanDevice(device),
              },
            }
            : {}),
        },
        shedBehavior,
      });
      return { ...device, residualKw: { ...device.residualKw, shed } };
    }).map(toInputRemainingSheddableDevice);
    const producerTotal = sumRemainingSheddableLoadKw({
      devices: producerDevices,
      isAlreadyShed: () => false,
      limitSource: 'capacity',
      capacityBreached: true,
    });

    // Baseline 2.9 + (a) 1.2 + (d) 0. Case (d) contributing 0 is the point:
    // the producer resolved a no-op setpoint shed to zero relief.
    expect(producerTotal).toBeCloseTo(2.9 + 1.2, 6);
  });

  // Adversarial guard: explicit per-device residual values so a future
  // refactor that flattens all branches to one path can't pass the cascade
  // assertion vacuously.
  it('each edge case yields its documented per-device residual under the producer path', () => {

    // (a) hasBinaryControl=false, at lowest active step (`low`) →
    //     `resolveSteppedShedTargetStepResidual` resolves a non-equal target
    //     step (`off`), so the shed is reachable; residual = measured draw.
    //     The producer's `canFinishSteppedTurnOffWithBinaryResidual` gate is
    //     only consulted when targetStep.id === selectedStepId, which is not
    //     the case here.
    expect(resolveRemainingSheddableLoadKw({
      device: toInputRemainingSheddableDevice(withFixtureResidualKw({
        ...buildPlanInputDevice({
          id: 'a',
          controllable: true,
          binaryControl: { on: true },
          controlModel: 'stepped_load',
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'low',
          binaryCapabilityId: undefined,
          measuredPowerKw: 1.2,
        }),
        residualKw: { shed: 1.2 },
      })),
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    })).toBeCloseTo(1.2, 6);

    // The former cases (b)/(c) — a stepped device with `selectedStepId`
    // absent — are unrepresentable: the producer refuses a stepped cluster
    // without its effective step, so there is no per-device residual left to
    // document for that shape.

    // (d) Temperature at shed setpoint → residual 0.
    expect(resolveRemainingSheddableLoadKw({
      device: toInputRemainingSheddableDevice(withFixtureResidualKw({
        ...buildPlanInputDevice({
          id: 'd',
          controllable: true,
          binaryControl: { on: true },
          measuredPowerKw: 1.4,
          targets: [{
            id: 'target_temperature',
            value: 18,
            unit: '°C',
            min: 5,
            max: 30,
            step: 0.5,
          }],
        }),
        residualKw: { shed: 0 },
      })),
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    })).toBe(0);
  });
});

// The missing-sensor planning path, which had no coverage while the fixture
// builder invented a reading for every device that spelled a setpoint. Production
// admits a temperature facet only with a real `measure_temperature` value
// (`resolveTemperatureObservation`), and without one `resolveResidualShedBehavior`
// falls back to `turn_off` — so the setpoint shed the owner configured frees the
// device's WHOLE draw, not the nothing a setpoint-already-there comparison would
// report.
describe('resolveResidualShedBehavior — a configured set_temperature shed without a sensor', () => {
  const heater = (
    overrides: Parameters<typeof buildPlanInputDevice>[0],
  ): PlanInputDevice => buildPlanInputDevice({
    id: 'heater',
    controllable: true,
    binaryControl: { on: true },
    measuredPowerKw: 1.4,
    shedBehavior: { action: 'set_temperature', temperature: 18 },
    ...overrides,
  });

  const remainingKw = (device: PlanInputDevice): number => resolveRemainingSheddableLoadKw({
    device: toInputRemainingSheddableDevice(device),
    alreadyShed: false,
    limitSource: 'capacity',
    capacityBreached: true,
  });

  it('frees the whole draw when the device reports no temperature at all', () => {
    const device = heater({ currentTarget: 18 });
    // No facet, so no cluster either — the discriminant and the residual agree.
    expect(isTemperaturePlanDevice(device)).toBe(false);
    expect(remainingKw(device)).toBeCloseTo(1.4, 6);
  });

  it('frees the whole draw when a reported device is still above the shed setpoint', () => {
    const device = heater({ currentTarget: 21, currentTemperature: 20.5 });
    expect(isTemperaturePlanDevice(device)).toBe(true);
    expect(remainingKw(device)).toBeCloseTo(1.4, 6);
  });

  it('frees nothing when a reported device already sits at the shed setpoint', () => {
    const device = heater({ currentTarget: 18, currentTemperature: 17.5 });
    expect(isTemperaturePlanDevice(device)).toBe(true);
    expect(remainingKw(device)).toBe(0);
  });
});
