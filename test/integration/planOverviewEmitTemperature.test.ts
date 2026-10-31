import { DeviceOverviewTransitions } from '../../lib/plan/planOverviewEmit';
import type { OverviewDecisionFacts } from '../../lib/plan/deviceOverviewLog';
import { buildSettingsOverviewReadModel } from '../../lib/plan/settingsOverviewReadModel';
import type { DevicePlan } from '../../lib/plan/planTypes';
import { PLAN_REASON_CODES, type DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { buildPlanDevice, buildPlanMeta } from '../utils/planTestUtils';
import { executionStateFixture } from '../utils/deviceStatusFixture';
import { buildOverviewDeviceCard, overviewReadModelWiring } from '../utils/settingsOverviewFixture';
import { createTestDeviceActivityRecorder } from '../helpers/deviceActivityRecorder';
import { insufficientHeadroomFixtureReason } from '../utils/deviceReasonTestUtils';

// The overview log and live-card seams share one atomic temperature resolver.
// Pin that integration here: the shared-domain classifier reads the trio as one
// object, so a carrier that misses the observer overlay can disagree with the
// state the owner sees on the card.
// The decision behind each card: the activity log reads its reason code.
const decisionWith = (reasonCode: DeviceReason['code']) => (): OverviewDecisionFacts => ({
  reasonCode, plannedState: 'keep', steppedStepUpHold: false, desiredStepId: null, observedStepId: null,
  binaryProgress: 'settled', stepProgress: 'undriven', targetProgress: 'undriven', stepCommandUnanswered: false,
});
const describeKeep = decisionWith(PLAN_REASON_CODES.keep);

describe('planOverviewEmit — temperature facet at the log seam', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 26, 18)); });
  afterEach(() => { vi.useRealTimers(); });

  const satisfiedTemperaturePlan = (): DevicePlan => ({
    meta: buildPlanMeta({ totalKw: 1, softLimitKw: 5, headroomKw: 4}),
    devices: [
      buildPlanDevice({
        id: 'thermostat',
        name: 'Hall Thermostat',
        deviceType: 'temperature',
        // Target-only: no on/off axis, so the state word is pure inference from
        // the temperature pair + draw.
        binaryControllable: false,
        currentState: 'not_applicable',
        plannedState: 'keep',
        // Room ABOVE target, drawing nothing: nothing left to do.
        currentTemperature: 20.8,
        currentTarget: 16,
        plannedTarget: 16,
        measuredPowerKw: 0,
        expectedPowerKw: 1,
      }),
    ],
    inverterDecisions: [],
    storageReleases: [],
  });

  it('classifies a satisfied target-only device as idle (the facet reaches the classifier)', () => {
    const recorder = createTestDeviceActivityRecorder();
    const plan = satisfiedTemperaturePlan();
    const deps = {
      ...overviewReadModelWiring(),
      getDeviceExecutionState: () => executionStateFixture(plan.devices[0]), dryRun: false, nowMs: 0,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getThermalDirection: () => 'heating' as const,
      getObservedTemperature: () => ({ kind: 'observed' as const,
        value: { currentTarget: 16, currentTemperature: 20.8 } }),
    };
    const snapshot = buildSettingsOverviewReadModel(plan, deps)!;
    const changed = new DeviceOverviewTransitions().capture(snapshot, recorder, describeKeep);

    expect(changed).toBe(true);
    const captured = recorder.getUiPayload().entries;
    expect(captured).toHaveLength(1);
    // Not `active`: with the facet absent from the seam's shape the classifier
    // cannot see the satisfied pair and falls back to the running inference.
    expect(captured[0]).toMatchObject({ deviceId: 'thermostat', stateKind: 'idle' });
  });

  it('adds no row while a thermostat at its target switches its own element on and off', () => {
    // Prod 2026-10-25: 0.8 kW for 3.5 min, idle for 6.6 min, all night, two rows a cycle.
    const recorder = createTestDeviceActivityRecorder();
    const transitions = new DeviceOverviewTransitions();
    const atTarget = (measuredPowerKw: number) => {
      const thermostat = buildPlanDevice({
        id: 'thermostat', name: 'Termostat', deviceType: 'temperature', binaryControllable: true,
        currentState: 'on', plannedState: 'keep', currentTemperature: 21, currentTarget: 21, plannedTarget: 21,
        measuredPowerKw, expectedPowerKw: 0.8,
      });
      return buildSettingsOverviewReadModel({ ...satisfiedTemperaturePlan(), devices: [thermostat] }, {
        ...overviewReadModelWiring(),
        getDeviceExecutionState: () => executionStateFixture(thermostat), dryRun: false, nowMs: 0,
        getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
        getHomeBatteryCard: () => ({ kind: 'none' } as const),
        getObservedEvChargingState: () => ({ kind: 'absent' } as const),
        getThermalDirection: () => 'heating' as const,
        getObservedTemperature: () => ({ kind: 'observed' as const,
          value: { currentTarget: 21, currentTemperature: 21 } }),
      })!;
    };
    const running = atTarget(0.8);
    const resting = atTarget(0);
    // The producer really flips the card, ease-off control included.
    expect(running.devices?.[0]?.status).toMatchObject({ kind: 'active', canEaseOff: true });
    expect(resting.devices?.[0]?.status).toMatchObject({ kind: 'idle', canEaseOff: false });
    for (const snapshot of [running, resting, running, resting]) {
      expect(transitions.capture(snapshot, recorder, describeKeep)).toBe(true);
    }
    expect(recorder.getUiPayload().entries).toHaveLength(1);
  });

  const heldThermostat = (reason: DeviceReason) => {
    const thermostat = buildPlanDevice({
      id: 'thermostat', name: 'Termostat', deviceType: 'temperature', binaryControllable: true,
      currentState: 'off', plannedState: 'shed', currentTemperature: 25.2, currentTarget: 26, plannedTarget: 26,
      measuredPowerKw: 0, expectedPowerKw: 1.1, reason,
    });
    const snapshot = buildSettingsOverviewReadModel({ ...satisfiedTemperaturePlan(), devices: [thermostat] }, {
      ...overviewReadModelWiring(),
      getDeviceExecutionState: () => executionStateFixture(thermostat), dryRun: false, nowMs: 0,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getThermalDirection: () => 'heating' as const,
      getObservedTemperature: () => ({ kind: 'observed' as const,
        value: { currentTarget: 26, currentTemperature: 25.2 } }),
    })!;
    return { snapshot, describe: decisionWith(reason.code) };
  };
  const recordedLines = (held: ReturnType<typeof heldThermostat>[]): string[] => {
    const recorder = createTestDeviceActivityRecorder();
    const transitions = new DeviceOverviewTransitions();
    // A minute apart, so each row outlasts the moment a row may still be replaced in.
    for (const { snapshot, describe } of held) {
      transitions.capture(snapshot, recorder, describe);
      vi.advanceTimersByTime(60_000);
    }
    return recorder.getUiPayload().entries.map((entry) => entry.statusMsg).reverse();
  };

  it('adds no row while a device waiting for cheaper hours passes through the pause after limiting a device', () => {
    // Prod 2026-10-26: the pause has no hold cause of its own, so a smart task's
    // hold dropping out and coming back wrote two rows each time.
    const cheaperHours = heldThermostat({ code: PLAN_REASON_CODES.deferredObjectiveAvoid });
    const pause = heldThermostat({ code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 45 });
    // The producer really drops the hold cause during the pause.
    expect(cheaperHours.snapshot.devices?.[0]?.status.holdCause).toBe('smart_task');
    expect(pause.snapshot.devices?.[0]?.status)
      .toMatchObject({ holdCause: null, reason: { countdown: { kind: 'in_text' } } });
    expect(recordedLines([cheaperHours, pause, cheaperHours])).toEqual(['Waiting for cheaper hours']);
  });

  it('keeps one row while a device held for power moves between the ways of waiting for it', () => {
    // Prod 2026-10-26: a thermostat held off for two hours wrote a row every
    // few minutes as the planner moved between these.
    expect(recordedLines([
      heldThermostat({ code: PLAN_REASON_CODES.dailyBudget, shortfallKw: 0.8 }),
      heldThermostat({ code: PLAN_REASON_CODES.cooldownShedding, remainingSec: 45 }),
      heldThermostat({ code: PLAN_REASON_CODES.waitingForOtherDevices }),
      heldThermostat({ code: PLAN_REASON_CODES.meterSettling }),
      heldThermostat(insufficientHeadroomFixtureReason({ needKw: 1.8, availableKw: 0.4 })),
      heldThermostat({ code: PLAN_REASON_CODES.dailyBudget, shortfallKw: 0.9 }),
      // A smart task's hold is not a wait for power: it is a row, and so is power again after it.
      heldThermostat({ code: PLAN_REASON_CODES.deferredObjectiveAvoid }),
      heldThermostat({ code: PLAN_REASON_CODES.waitingForOtherDevices }),
    ])).toEqual([
      'Waiting to resume — 0.8 kW more needed',
      'Waiting for cheaper hours',
      'Waiting to resume — other devices are ahead',
    ]);
  });

  it('reads a satisfied thermostat that reports on as Idle on its card, not Running at 0 kW', () => {
    const onThermostat = buildPlanDevice({
      id: 'thermostat',
      name: 'Hall Thermostat',
      deviceType: 'temperature',
      // An on/off axis that reports on while the room is above target.
      binaryControllable: true,
      currentState: 'on',
      plannedState: 'keep',
      currentTemperature: 20.8,
      currentTarget: 16,
      plannedTarget: 16,
      measuredPowerKw: 0,
      expectedPowerKw: 1,
    });
    const onPlan: DevicePlan = { ...satisfiedTemperaturePlan(), devices: [onThermostat] };
    const snapshot = buildSettingsOverviewReadModel(onPlan, {
      ...overviewReadModelWiring(),
      getDeviceExecutionState: () => executionStateFixture(onThermostat), dryRun: false, nowMs: 0,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getThermalDirection: () => 'heating' as const,
      getObservedTemperature: () => ({ kind: 'observed' as const,
        value: { currentTarget: 16, currentTemperature: 20.8 } }),
    })!;

    expect(snapshot.devices?.[0]?.status).toMatchObject({ kind: 'idle', label: 'Idle' });
  });

  it('uses the same fresher observer pair for the live card and activity log', () => {
    const plan = satisfiedTemperaturePlan();
    const staleDevice = plan.devices[0];
    if (!staleDevice) throw new Error('expected thermostat fixture');
    const updatedDevice = {
      ...staleDevice,
      currentTarget: 21,
      plannedTarget: 21,
      currentTemperature: 20.8,
    };
    const stalePlan = {
      ...plan,
      devices: [updatedDevice],
    } as DevicePlan;
    const deps = {
      ...overviewReadModelWiring(),
      getDeviceExecutionState: () => executionStateFixture(updatedDevice), dryRun: false, nowMs: 0,
      getObservedStateOfCharge: () => ({ kind: 'absent' } as const),
      getHomeBatteryCard: () => ({ kind: 'none' } as const),
      getObservedEvChargingState: () => ({ kind: 'absent' } as const),
      getThermalDirection: () => 'heating' as const,
      getObservedTemperature: () => ({
        kind: 'observed' as const,
        value: { currentTarget: 21, currentTemperature: 21.1 },
      }),
      getObservationStale: () => false,
    };
    const recorder = createTestDeviceActivityRecorder();

    new DeviceOverviewTransitions().capture(buildSettingsOverviewReadModel(stalePlan, deps)!, recorder, describeKeep);

    expect(buildOverviewDeviceCard(updatedDevice, deps).status.kind).toBe('idle');
    expect(recorder.getUiPayload().entries[0]).toMatchObject({ deviceId: 'thermostat', stateKind: 'idle' });
  });
});
