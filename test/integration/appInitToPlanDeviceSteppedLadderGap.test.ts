import { withDeviceConfiguration } from '../utils/planTestUtils';
/**
 * A persisted Flow ladder survives a transport restart even before actual-step
 * feedback arrives. Owner parsing, runtime composition, and planner projection
 * retain that chosen ladder; absent feedback is an unknown observed rung.
 *
 * Separate contract tests exercise the producer's whole-cluster refusal when a
 * caller bypasses effective-step projection. Those fixtures keep complete
 * owner configuration and deliberately omit the downstream selected step.
 */
import Homey from 'homey';
import { describe, expect, it } from 'vitest';
import { createTestDeviceTransport } from '../helpers/deviceTransportHarness';
import { mockHomeyInstance } from '../mocks/homey';
import { getLogger } from '../../lib/logging/logger';
import { projectObservedState } from '../../lib/device/observedStateProjection';
import { readRuntimeDevice } from '../../lib/planInput/runtimeDeviceRead';
import { decorateSnapshotWithDeviceControl } from '../../lib/planInput/deviceControlProjection';
import { steppedStoresForTest } from '../helpers/steppedStores';
import type { HomeyDeviceLike, Logger } from '../../lib/utils/types';
import { toPlanDevice } from '../../setup/appInit';
import { createAppContextMock } from '../helpers/appContextTestHelpers';
import { decoratedSnapshotFixture } from '../utils/deviceSnapshotFixture';
import { isSteppedLoadDevice } from '../../lib/plan/planSteppedLoad';
import { resolveObjectiveSteps } from '../../lib/objectives/deferredObjectives/objectiveSteps';
import { resolvePlanningSpeedKw } from '../../lib/objectives/deferredObjectives/planningSpeed';
import {
  type ObjectiveDeviceInput,
  type ObjectiveDeviceSource,
  resolveObjectiveDeviceInputs,
} from '../../lib/objectives/types';
import type {
  DecoratedDeviceSnapshot,
  MeasuredPowerObservedProbe,
  SteppedLoadProfile,
} from '../../packages/contracts/src/types';

// `toPlanDevice` is the per-device half of a two-stage producer: ranking needs
// the SET, so `buildHomePlanDevices` stamps `priority` right after. These specs
// exercise the first half alone, so they stand in for the second.
const ranked = <T extends object>(device: T): T & { priority: number } => ({ ...device, priority: 1 });


const USABLE_LADDER: SteppedLoadProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1_250 },
    { id: 'max', planningPowerW: 3_000 },
  ],
};

const buildSnapshot = (
  overrides: Partial<DecoratedDeviceSnapshot & MeasuredPowerObservedProbe>,
): DecoratedDeviceSnapshot & MeasuredPowerObservedProbe => decoratedSnapshotFixture({
  id: 'tank',
  name: 'Water heater',
  expectedPowerKw: 1,
  expectedPowerSource: 'default',
  targets: [],
  binaryControl: { on: false },
  ...overrides,
  available: overrides.available ?? true,
});

const resolveSavedFlowPlanDevice = (profile: SteppedLoadProfile, observedAtMs: number) => {
  const logger: Logger = { log: () => {}, error: () => {}, structuredLog: getLogger('devices') };
  const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App, logger, {
    getHomeyEnergyMeterSelection: () => ({ state: 'unavailable' }),
    getDeviceControlProfile: () => profile,
  });
  const lastUpdated = new Date(observedAtMs).toISOString();
  const device: HomeyDeviceLike = {
    id: 'tank', name: 'Water heater', class: 'heater', available: true, ready: true,
    capabilities: ['onoff', 'measure_power', 'measure_temperature', 'target_temperature'],
    capabilitiesObj: {
      onoff: { value: false, setable: true, lastUpdated },
      measure_power: { value: 0, lastUpdated },
      measure_temperature: { value: 55, lastUpdated },
      target_temperature: { value: 70, setable: true, min: 0, max: 95, step: 0.5, lastUpdated },
    },
  };
  const [snapshot] = transport.parseDeviceListForTests([device]);
  if (!snapshot) throw new Error('The valid SDK fixture must resolve a device.');
  transport.setSnapshotForTests([snapshot]);
  const runtime = readRuntimeDevice(transport.deviceConfigurationStore.get('tank'), projectObservedState(snapshot));
  if (!runtime) throw new Error('The accepted fixture must publish runtime configuration and observation.');
  const { store } = steppedStoresForTest();
  const projected = decorateSnapshotWithDeviceControl(runtime, store, false, false);
  return ranked(toPlanDevice(createAppContextMock(), projected));
};

describe('toPlanDevice resolved ladder and projection contract', () => {
  it('retains the saved Flow ladder across restart before any actual-step feedback', () => {
    const beforeRestart = resolveSavedFlowPlanDevice(USABLE_LADDER, Date.UTC(2026, 8, 30, 8));
    const afterRestart = resolveSavedFlowPlanDevice(USABLE_LADDER, Date.UTC(2026, 8, 30, 8, 5));

    expect(isSteppedLoadDevice(beforeRestart)).toBe(true);
    expect(isSteppedLoadDevice(afterRestart)).toBe(true);
    if (!isSteppedLoadDevice(beforeRestart) || !isSteppedLoadDevice(afterRestart)) {
      throw new Error('Both accepted restart reads must retain the stepped axis.');
    }
    expect(afterRestart.steppedLoadProfile).toEqual(beforeRestart.steppedLoadProfile);
    expect(afterRestart.selectedStepId).toBe('low');
    expect(afterRestart.reportedStepId).toBeUndefined();
    expect('steppedLadderMissing' in afterRestart).toBe(false);
    const objectiveDevice = asObjectiveDevice(afterRestart);
    expect(resolveObjectiveSteps(objectiveDevice).map((step) => step.id)).toEqual(['off', 'low', 'max']);
    expect(resolvePlanningSpeedKw(objectiveDevice)).toBe(1.25);
  });

  it('rejects an unusable saved ladder at its owner before planner projection', () => {
    const planDevice = resolveSavedFlowPlanDevice({ steps: [{ id: 'off', planningPowerW: 0 }] },
      Date.UTC(2026, 8, 30, 8));

    expect(isSteppedLoadDevice(planDevice)).toBe(false);
    expect(planDevice.controlModel).toBe('temperature_target');
    expect('steppedLadderMissing' in planDevice).toBe(false);
  });

  it('flags the projection-contract gap when a caller bypasses effective-step composition', () => {
    // The producer contract behind `SteppedLoadKind.selectedStepId: string`:
    // the decorator resolves an effective step for every usable ladder, so a
    // carrier with a ladder but no step is a contract violator — the producer
    // refuses the whole cluster rather than shipping a stepped device with a
    // hole where its step should be, and the ladder-gap bit records why the
    // stepped answer is missing.
    const planDevice = ranked(toPlanDevice(createAppContextMock(), withDeviceConfiguration(buildSnapshot({
      controlModel: 'stepped_load',
      steppedLoadProfile: USABLE_LADDER,
      // No `selectedStepId` — the violating shape under test.
    }))));

    expect(isSteppedLoadDevice(planDevice)).toBe(false);
    expect(planDevice.steppedLadderMissing).toBe(true);
  });

  it('leaves the bit off when the ladder resolves', () => {
    const planDevice = ranked(toPlanDevice(createAppContextMock(), withDeviceConfiguration(buildSnapshot({
      controlModel: 'stepped_load',
      steppedLoadProfile: USABLE_LADDER,
      // The decorator resolves the effective step for every usable ladder; a
      // snapshot without one has its cluster refused (producer contract).
      selectedStepId: 'low',
    }))));

    expect(isSteppedLoadDevice(planDevice)).toBe(true);
    // Absent, not `false` — one spelling for "no gap", like `surplusOnly`.
    expect('steppedLadderMissing' in planDevice).toBe(false);
  });

  it('leaves the bit off for a device that was never stepped', () => {
    // The distinction the whole bit exists for: a plain binary device also
    // reaches the planner with no profile, and it is NOT in a gap — the
    // smart-task stack may synthesise a charge rate for it.
    const planDevice = ranked(toPlanDevice(createAppContextMock(), withDeviceConfiguration(buildSnapshot({
      controlModel: 'binary_power',
    }))));

    expect('steppedLadderMissing' in planDevice).toBe(false);
  });

  it('keeps the ladder for a stepped device whose temperature control is disabled', () => {
    // "Disable temperature control" denies the `target_temperature` capability,
    // not the step axis. `projectEffectiveControlDevice` used to re-project this
    // device to plain binary power for the whole cycle, which cost a stepped
    // water heater its ladder — PELS could only switch it off, never trim it.
    const planDevice = ranked(toPlanDevice(createAppContextMock(), withDeviceConfiguration(buildSnapshot({
      controlModel: 'stepped_load',
      steppedLoadProfile: USABLE_LADDER,
      selectedStepId: 'low',
      temperatureControlDisabled: true,
    }))));

    expect(isSteppedLoadDevice(planDevice)).toBe(true);
    expect('steppedLadderMissing' in planDevice).toBe(false);
  });
});

// Consumer safeguards read the producer's projection-contract gap. This input
// retains the owner-resolved profile but deliberately bypasses its selected-step
// composition; it represents a projection defect, not missing Homey telemetry.
// The smart-task consumers only ever see a device with a power reading:
// production narrows the plan's devices through `selectObjectiveDevices` before
// either consumer is asked, so the join does the same, and its snapshots carry
// an idle reading.
const asObjectiveDevice = (device: ObjectiveDeviceSource): ObjectiveDeviceInput => {
  const [selected] = resolveObjectiveDeviceInputs([device], () => 'heating');
  if (!selected) throw new Error('fixture: the reading must make the device an objective device');
  return selected;
};

describe('projection-contract gap: producer output through the consumers', () => {
  it('makes both consumers withhold for a missing effective-step projection', () => {
    const planDevice = asObjectiveDevice(ranked(toPlanDevice(createAppContextMock(), withDeviceConfiguration(buildSnapshot({
      measuredPowerKw: 0,
      controlModel: 'stepped_load',
      steppedLoadProfile: USABLE_LADDER,
      targets: [{ id: 'target_temperature', value: 70, unit: 'C', min: 0, max: 95, step: 0.5 }],
      deviceType: 'temperature',
    })))));

    // Not asserted as a precondition — read back so a failure here names the
    // producer rather than blaming the consumers for its omission.
    expect(planDevice.steppedLadderMissing).toBe(true);
    expect(resolveObjectiveSteps(planDevice)).toEqual([]);
    expect(resolvePlanningSpeedKw(planDevice)).toBeNull();
  });

  it('lets both consumers answer once the ladder resolves', () => {
    // The negative control. Same device, ladder present: the gap is not stamped
    // and neither consumer withholds — so the case above is proving the gap, not
    // some unrelated reason these two return empty.
    const planDevice = asObjectiveDevice(ranked(toPlanDevice(createAppContextMock(), withDeviceConfiguration(buildSnapshot({
      measuredPowerKw: 0,
      controlModel: 'stepped_load',
      steppedLoadProfile: USABLE_LADDER,
      selectedStepId: 'low',
      targets: [{ id: 'target_temperature', value: 70, unit: 'C', min: 0, max: 95, step: 0.5 }],
      deviceType: 'temperature',
    })))));

    expect('steppedLadderMissing' in planDevice).toBe(false);
    expect(resolveObjectiveSteps(planDevice).length).toBeGreaterThan(0);
    expect(resolvePlanningSpeedKw(planDevice)).not.toBeNull();
  });
});
