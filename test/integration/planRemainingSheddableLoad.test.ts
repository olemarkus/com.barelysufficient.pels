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
import { getCurrentDrawKw } from '../../lib/observer/observedPower';
import { getPrimaryTargetCapability } from '../../lib/utils/targetCapabilities';
import { buildPlanDevice, buildPlanInputDevice, steppedProfile } from '../utils/planTestUtils';
import type { PlanInputDevice } from '../../lib/plan/planTypes';

describe('resolveRemainingSheddableLoadKw — stale observation handling', () => {
  const turnOffBehavior: RemainingShedBehavior = { action: 'turn_off' };

  it('falls back to configured demand for a stale currentOn=false device instead of reporting 0', () => {
    // Regression: stale snapshots with currentOn: false and missing live
    // measurement must not be silently zeroed out — the device may still be
    // drawing, and excluding it from remaining sheddable load can mis-signal
    // "no actionable load left" during shortfall handling. In production the
    // plan-device projection already maps stale devices to currentState
    // 'unknown', which lets resolveEffectiveCurrentOn return null so the
    // observationStale-aware getCurrentDrawKw branch can take over.
    const stale = toPlanRemainingSheddableDevice(buildPlanDevice({
      id: 'stale-off',
      controllable: true,
      currentOn: false,
      currentState: 'unknown',
      observationStale: true,
      expectedPowerKw: 1.4,
    }));
    const kw = resolveRemainingSheddableLoadKw({
      device: stale,
      shedBehavior: turnOffBehavior,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    });
    expect(kw).toBeCloseTo(1.4, 6);
  });

  it('still returns 0 for a fresh currentOn=false device — shedding gives no immediate relief', () => {
    const fresh = toPlanRemainingSheddableDevice(buildPlanDevice({
      id: 'fresh-off',
      controllable: true,
      currentOn: false,
      currentState: 'off',
      observationStale: false,
      expectedPowerKw: 1.4,
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
      currentOn: true,
      currentState: 'on',
      measuredPowerKw: 1.4,
    });
    const steppedMax = buildPlanInputDevice({
      id: 'stepped-max',
      controllable: true,
      currentOn: true,
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'max',
      hasBinaryControl: true,
      measuredPowerKw: 2.9,
    });
    const steppedAtLowestActive = buildPlanInputDevice({
      id: 'stepped-low',
      controllable: true,
      currentOn: true,
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      hasBinaryControl: true,
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
  // Four edge cases the producer-resolved path and the legacy fallback handle:
  //   (a) Stepped, `hasBinaryControl: false`, already at the lowest active
  //       step. With selectedStepId set, both paths see a target step
  //       different from the current step → both report residual = measured
  //       draw. (The binary-finish gate that would zero this out only fires
  //       when the target step ID equals the current step ID.)
  //   (b) Stepped with `selectedStepId` absent and `hasKnownEffectiveStep`
  //       false. Both paths take the unknown-current-measured fallback;
  //       positive measured power and an off step yield residual = measured.
  //   (c) Stepped with `selectedStepId` absent but `hasKnownEffectiveStep`
  //       true (via `reportedStepId`). KNOWN DIVERGENCE — see the dedicated
  //       test below. Not part of the cascade total (would fail watt-equality).
  //   (d) Temperature device with `currentValue == normalized shedTemperature`.
  //       Both paths reject the shed via `canStillShedTemperature` → 0.
  it('agrees with the legacy fallback across the cascade-parity edge cases (a, b, d)', () => {
    // The cascade also includes a positive-residual baseline (steppedMax) so
    // the watt-equality assertion has something non-zero to anchor on.
    const baselineSteppedMax = buildPlanInputDevice({
      id: 'baseline-stepped-max',
      controllable: true,
      currentOn: true,
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'max',
      hasBinaryControl: true,
      measuredPowerKw: 2.9,
    });

    // (a) Stepped, no binary control, already at the lowest active step.
    const steppedLowestNoBinary = buildPlanInputDevice({
      id: 'edge-a-stepped-lowest-no-binary',
      controllable: true,
      currentOn: true,
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      selectedStepId: 'low',
      hasBinaryControl: false,
      measuredPowerKw: 1.2,
    });

    // (b) Stepped with selectedStepId absent and hasKnownEffectiveStep false.
    //     Measured-power fallback through `canShedFromUnknownCurrentStep`.
    const steppedUnknownNoEffective = buildPlanInputDevice({
      id: 'edge-b-stepped-unknown-no-effective',
      controllable: true,
      currentOn: true,
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      hasBinaryControl: true,
      measuredPowerKw: 1.8,
    });

    // (d) Temperature device with `currentValue == normalized shedTemperature`.
    //     `canStillShedTemperature` returns false; residual = 0.
    const temperatureNoopShed = buildPlanInputDevice({
      id: 'edge-d-temperature-noop',
      controllable: true,
      currentOn: true,
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
      steppedUnknownNoEffective,
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
      const shedBehavior: ResidualKwShedBehavior = device.id === temperatureNoopShed.id
        ? { action: 'set_temperature', temperature: 18 }
        : { action: 'turn_off' };
      const stepState = device.controlModel === 'stepped_load' && device.steppedLoadProfile
        ? normalizeSteppedLoadStepStateFromLegacyFields({
          fields: device,
          selectedStepFallbackIsPlanningAssumption: true,
        })
        : null;
      const target = getPrimaryTargetCapability(device.targets);
      const shed = resolveResidualKwShed({
        device: {
          currentDrawKw: getCurrentDrawKw(device),
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
          ...(device.controlModel === 'stepped_load' && device.steppedLoadProfile && stepState
            ? {
              steppedLoad: {
                profile: device.steppedLoadProfile,
                ...(device.selectedStepId !== undefined ? { selectedStepId: device.selectedStepId } : {}),
                hasKnownEffectiveStep: resolveKnownEffectiveStepId(stepState) !== undefined,
                ...(typeof device.measuredPowerKw === 'number'
                  ? { measuredPowerKw: device.measuredPowerKw }
                  : {}),
                ...(typeof device.hasBinaryControl === 'boolean'
                  ? { hasBinaryControl: device.hasBinaryControl }
                  : {}),
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
    // Pin the absolute total too — baseline 2.9 + (a) 1.2 + (b) 1.8 + (d) 0.
    // If a future refactor accidentally collapses a positive case to 0 (or
    // vice versa) but keeps producer/legacy aligned, the cross-path
    // assertion still passes while this one fires.
    expect(producerTotal).toBeCloseTo(2.9 + 1.2 + 1.8, 6);
  });

  // Edge case (c) — known divergence between producer-resolved and legacy
  // fallback paths. Pinned explicitly so chunk 6 (which removes the legacy
  // fallback) doesn't accidentally regress production behavior.
  //
  // Background: `RemainingSheddableSteppedFields` in this module strips
  // `reportedStepId` (and the device's other step evidence) when projecting a
  // `PlanInputDevice` into a `RemainingSheddableDevice`. As a result the
  // legacy `resolveSteppedUnknownCurrentMeasuredShedding` (which gates on
  // `resolvePlannerEffectiveStepId`) sees an effectively unknown step state
  // and falls through to the measured-power fallback. The producer-resolved
  // path is wired upstream of that projection (`residualKwForPlanDevice.ts`
  // reads the raw `TargetDeviceSnapshot`), sees `reportedStepId`, computes
  // `hasKnownEffectiveStep === true`, and rejects the measured-power
  // fallback in `canShedFromUnknownCurrentStep` → residual = 0.
  //
  // In production the producer is always wired (chunk 3 onwards), so the
  // legacy fallback never runs on devices that carry `reportedStepId`. This
  // test pins the per-path values so the asymmetry is captured in code.
  it('pins the legacy-vs-producer drift for stepped with reportedStepId-only (case c)', () => {
    const device = buildPlanInputDevice({
      id: 'edge-c-stepped-unknown-but-reported',
      controllable: true,
      currentOn: true,
      currentState: 'on',
      controlModel: 'stepped_load',
      steppedLoadProfile: steppedProfile,
      hasBinaryControl: true,
      reportedStepId: 'medium',
      measuredPowerKw: 2.05,
    });
    const turnOff: RemainingShedBehavior = { action: 'turn_off' };

    // Legacy fallback: reportedStepId is stripped by the
    // RemainingSheddableSteppedFields projection, so the legacy chain takes
    // the measured-power fallback.
    const legacyKw = resolveRemainingSheddableLoadKw({
      device: toInputRemainingSheddableDevice(device),
      shedBehavior: turnOff,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    });
    expect(legacyKw).toBeCloseTo(2.05, 6);

    // Producer-resolved (computed exactly as `residualKwForPlanDevice.ts`):
    // hasKnownEffectiveStep=true rejects the measured-power fallback → 0.
    const stepState = normalizeSteppedLoadStepStateFromLegacyFields({
      fields: device,
      selectedStepFallbackIsPlanningAssumption: true,
    });
    const producerShed = resolveResidualKwShed({
      device: {
        currentDrawKw: getCurrentDrawKw(device),
        steppedLoad: {
          profile: device.steppedLoadProfile!,
          hasKnownEffectiveStep: resolveKnownEffectiveStepId(stepState) !== undefined,
          measuredPowerKw: device.measuredPowerKw,
          hasBinaryControl: device.hasBinaryControl,
        },
      },
      shedBehavior: { action: 'turn_off' },
    });
    expect(producerShed).toBe(0);

    const producerKw = resolveRemainingSheddableLoadKw({
      device: toInputRemainingSheddableDevice({ ...device, residualKw: { shed: producerShed } }),
      shedBehavior: turnOff,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    });
    expect(producerKw).toBe(0);
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
          currentOn: true,
          controlModel: 'stepped_load',
          steppedLoadProfile: steppedProfile,
          selectedStepId: 'low',
          hasBinaryControl: false,
          measuredPowerKw: 1.2,
        }),
        residualKw: { shed: 1.2 },
      }),
      shedBehavior: turnOff,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    })).toBeCloseTo(1.2, 6);

    // (b) Stepped, selectedStepId absent, hasKnownEffectiveStep=false →
    //     residual = measured.
    expect(resolveRemainingSheddableLoadKw({
      device: toInputRemainingSheddableDevice({
        ...buildPlanInputDevice({
          id: 'b',
          controllable: true,
          currentOn: true,
          controlModel: 'stepped_load',
          steppedLoadProfile: steppedProfile,
          hasBinaryControl: true,
          measuredPowerKw: 1.8,
        }),
        residualKw: { shed: 1.8 },
      }),
      shedBehavior: turnOff,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    })).toBeCloseTo(1.8, 6);

    // (c) Stepped, selectedStepId absent, hasKnownEffectiveStep=true (via
    //     reportedStepId) → unknown-current-measured fallback rejects on the
    //     flag → residual = 0.
    expect(resolveRemainingSheddableLoadKw({
      device: toInputRemainingSheddableDevice({
        ...buildPlanInputDevice({
          id: 'c',
          controllable: true,
          currentOn: true,
          controlModel: 'stepped_load',
          steppedLoadProfile: steppedProfile,
          hasBinaryControl: true,
          reportedStepId: 'medium',
          measuredPowerKw: 2.05,
        }),
        residualKw: { shed: 0 },
      }),
      shedBehavior: turnOff,
      alreadyShed: false,
      limitSource: 'capacity',
      capacityBreached: true,
    })).toBe(0);

    // (d) Temperature at shed setpoint → residual 0.
    expect(resolveRemainingSheddableLoadKw({
      device: toInputRemainingSheddableDevice({
        ...buildPlanInputDevice({
          id: 'd',
          controllable: true,
          currentOn: true,
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
