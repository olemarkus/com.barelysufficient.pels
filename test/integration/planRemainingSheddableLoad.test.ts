import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import {
  resolveRemainingSheddableLoadKw,
  sumRemainingSheddableLoadKw,
  toInputRemainingSheddableDevice,
  toPlanRemainingSheddableDevice,
  type RemainingShedBehavior,
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
} from '../utils/planTestUtils';
import {
  type BinaryControlDiscriminantProbe,
  type DevicePlanDevice,
  type PlanInputDevice,
  type SteppedDiscriminantProbe,
  withBinaryDiscriminant,
} from '../../lib/plan/planTypes';
import { isBinaryPlanDevice } from '../../lib/plan/planBinaryDevice';

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
  const turnOffBehavior: RemainingShedBehavior = { action: 'turn_off' };

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
      shedBehavior: turnOffBehavior,
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
      shedBehavior: turnOffBehavior,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    });
    expect(kw).toBe(0);
  });
});

describe('sumRemainingSheddableLoadKw — chunk-3 producer-resolved path parity', () => {
  // Behaviour-preservation regression for the producer-resolved residual.
  // We build a representative cascade scenario (mixed simple / temperature /
  // stepped devices) and assert that the producer-resolved path yields the
  // same total as the legacy dual-read fallback. The dual-read fallback fires
  // when `residualKw` is absent; the producer-resolved path fires when it is
  // populated.
  const turnOffBehavior: RemainingShedBehavior = { action: 'turn_off' };

  it('agrees with the legacy fallback across a representative cascade scenario', () => {
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

    // Legacy fallback path — residualKw absent on every input.
    const legacyDevices = [simpleOn, steppedMax, steppedAtLowestActive].map(toInputRemainingSheddableDevice);
    const legacyTotal = sumRemainingSheddableLoadKw({
      devices: legacyDevices,
      shedBehaviorForDevice: () => turnOffBehavior,
      isAlreadyShed: () => false,
      limitSource: 'capacity',
      capacityBreached: true,
    });

    // Producer-resolved path — populate residualKw with what the producer
    // would emit for a turn_off shed. The shape mirrors `toPlanDevice` in
    // `setup/appInit.ts`.
    const producerDevices = [
      { ...simpleOn, residualKw: { shed: 1.4 } },
      { ...steppedMax, residualKw: { shed: 2.9 } },
      // Already at lowest active + has binary control → producer says it can
      // still shed via the binary capability.
      { ...steppedAtLowestActive, residualKw: { shed: 1.2 } },
    ].map(toInputRemainingSheddableDevice);
    const producerTotal = sumRemainingSheddableLoadKw({
      devices: producerDevices,
      shedBehaviorForDevice: () => turnOffBehavior,
      isAlreadyShed: () => false,
      limitSource: 'capacity',
      capacityBreached: true,
    });

    expect(producerTotal).toBeCloseTo(legacyTotal, 6);
    expect(producerTotal).toBeGreaterThan(0);
  });

  // Edge-case cascade-parity coverage added 2026-05-27. Closes TODO §"Before
  // chunk 6 — expand cascade-parity test in test/planRemainingSheddableLoad.test.ts."
  //
  // Edge cases the producer-resolved path and the legacy fallback handle.
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
  it('agrees with the legacy fallback across the cascade-parity edge cases (a, d)', () => {
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

    const turnOff: RemainingShedBehavior = { action: 'turn_off' };
    const setTemperatureTo18: RemainingShedBehavior = { action: 'set_temperature', temperature: 18 };
    const shedBehaviorForDevice = (device: { id: string }): RemainingShedBehavior => (
      device.id === temperatureNoopShed.id ? setTemperatureTo18 : turnOff
    );

    const fixtures = [
      baselineSteppedMax,
      steppedLowestNoBinary,
      temperatureNoopShed,
    ];

    // Legacy fallback path — residualKw absent on every input.
    const legacyDevices = fixtures.map(toInputRemainingSheddableDevice);
    const legacyTotal = sumRemainingSheddableLoadKw({
      devices: legacyDevices,
      shedBehaviorForDevice,
      isAlreadyShed: () => false,
      limitSource: 'capacity',
      capacityBreached: true,
    });

    // Producer-resolved path — populate `residualKw.shed` using the same
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
      return { ...device, residualKw: { shed } };
    }).map(toInputRemainingSheddableDevice);
    const producerTotal = sumRemainingSheddableLoadKw({
      devices: producerDevices,
      shedBehaviorForDevice,
      isAlreadyShed: () => false,
      limitSource: 'capacity',
      capacityBreached: true,
    });

    // Watt-equality across the cascade for the agreeing edge cases (a, b, d).
    expect(producerTotal).toBeCloseTo(legacyTotal, 6);
    // Pin the absolute total too — baseline 2.9 + (a) 1.2 + (d) 0.
    // If a future refactor accidentally collapses a positive case to 0 (or
    // vice versa) but keeps producer/legacy aligned, the cross-path
    // assertion still passes while this one fires.
    expect(producerTotal).toBeCloseTo(2.9 + 1.2, 6);
  });

  // Adversarial guard: explicit per-device residual values so a future
  // refactor that flattens all branches to one path can't pass the cascade
  // assertion vacuously.
  it('each edge case yields its documented per-device residual under the producer path', () => {
    const turnOff: RemainingShedBehavior = { action: 'turn_off' };
    const setTo18: RemainingShedBehavior = { action: 'set_temperature', temperature: 18 };

    // (a) hasBinaryControl=false, at lowest active step (`low`) →
    //     `resolveSteppedShedTargetStepResidual` resolves a non-equal target
    //     step (`off`), so the shed is reachable; residual = measured draw.
    //     The producer's `canFinishSteppedTurnOffWithBinaryResidual` gate is
    //     only consulted when targetStep.id === selectedStepId, which is not
    //     the case here.
    expect(resolveRemainingSheddableLoadKw({
      device: toInputRemainingSheddableDevice({
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
      }),
      shedBehavior: turnOff,
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
      device: toInputRemainingSheddableDevice({
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
      }),
      shedBehavior: setTo18,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    })).toBe(0);
  });
});
