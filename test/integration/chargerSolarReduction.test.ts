import type { DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import { PLAN_REASON_CODES } from '../../packages/shared-domain/src/planReasonSemantics';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { buildPlanCycle } from '../utils/planContextPowerFixture';
import {
  buildInitialPlanDevicesForSpec, buildPlanInputDevice, sheddingPlanFixture, steppedInputDevice,
} from '../utils/planTestUtils';

describe('solar-only charger reductions stay outside capacity recovery timing', () => {
  it.each([
    { name: 'surplus-only hold', surplusOnly: true, surplusTracking: false, stopped: true },
    { name: 'stopped tracking hold', surplusOnly: false, surplusTracking: true, stopped: true },
    { name: 'tracking ceiling', surplusOnly: false, surplusTracking: true, stopped: false },
  ])('classifies a $name without a capacity shed timestamp', ({ surplusOnly, surplusTracking, stopped }) => {
    const state = createPlanEngineState();
    state.surplusTrackingByDevice.charger = stopped
      ? { kind: 'stopped' }
      : { kind: 'rung', stepId: 'low', funded: true };
    const charger = steppedInputDevice({
      id: 'charger', isEvCharger: true, surplusTracking,
      ...(surplusOnly ? { surplusOnly: true as const } : {}),
      selectedStepId: 'max', desiredStepId: 'max', currentDrawKw: 3,
      binaryControl: { on: true }, controllable: true,
    });
    const { context } = buildPlanCycle({ devices: [charger], total: 3, softLimit: 10 });

    const [device] = buildInitialPlanDevicesForSpec({
      context,
      state,
      sheddingPlan: sheddingPlanFixture({ shedSet: new Set(stopped ? ['charger'] : []) }),
      deps: {
        getInferredSurplusKw: () => 0,
        getShedBehavior: () => ({ action: 'set_step' }),
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      },
    });

    expect(device.desiredStepId).toBe('low');
    expect(device.nonCapacityHoldShed).toBe(true);
  });

  it.each([
    { code: PLAN_REASON_CODES.capacity, tracking: false },
    { code: PLAN_REASON_CODES.capacity, tracking: true },
    { code: PLAN_REASON_CODES.dailyBudget, tracking: false },
    { code: PLAN_REASON_CODES.dailyBudget, tracking: true },
  ])(
    'preserves capacity recording under $code (tracking: $tracking)',
    ({ code, tracking }) => {
      const state = createPlanEngineState();
      state.surplusTrackingByDevice.charger = { kind: 'stopped' };
      const charger = steppedInputDevice({
        id: 'charger', isEvCharger: true, surplusTracking: tracking,
        ...(!tracking ? { surplusOnly: true as const } : {}),
        selectedStepId: 'max', desiredStepId: 'max', currentDrawKw: 3,
        binaryControl: { on: true }, controllable: true,
      });
      const { context } = buildPlanCycle({ devices: [charger], total: 3, softLimit: 1 });
      const shedReasons = new Map<string, DeviceReason>([['charger', { code }]]);

      const [device] = buildInitialPlanDevicesForSpec({
        context,
        state,
        sheddingPlan: sheddingPlanFixture({ shedSet: new Set(['charger']), shedReasons }),
        deps: {
          getInferredSurplusKw: () => 0,
          getShedBehavior: () => ({ action: 'set_step' }),
          getPriceOptimizationSettings: () => ({}),
          pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
        },
      });

      expect(device.desiredStepId).toBe('low');
      expect(device.nonCapacityHoldShed).toBeUndefined();
    },
  );

  it('keeps a fairness reduction capacity-driven when a solar ceiling also exists', () => {
    const state = createPlanEngineState();
    state.surplusTrackingByDevice.charger = { kind: 'rung', stepId: 'low', funded: true };
    const charger = steppedInputDevice({
      id: 'charger', isEvCharger: true, surplusTracking: true,
      selectedStepId: 'max', desiredStepId: 'max', currentDrawKw: 3,
      binaryControl: { on: true }, controllable: true,
    });
    const other = buildPlanInputDevice({ id: 'other', currentDrawKw: 1, binaryControl: { on: true } });
    const { context } = buildPlanCycle({ devices: [charger, other], total: 4, softLimit: 3 });

    const [device] = buildInitialPlanDevicesForSpec({
      context,
      state,
      sheddingPlan: sheddingPlanFixture({
        shedSet: new Set(['other']),
        shedReasons: new Map([['other', { code: PLAN_REASON_CODES.capacity }]]),
      }),
      deps: {
        getInferredSurplusKw: () => 0,
        getShedBehavior: (id) => ({ action: id === 'other' ? 'turn_off' : 'set_step' }),
        getPriceOptimizationSettings: () => ({}),
        pendingBinaryCommandStore: createPendingBinaryCommandStore(state.pendingBinaryCommands),
      },
    });

    expect(device.desiredStepId).toBe('low');
    expect(device.nonCapacityHoldShed).toBeUndefined();
  });
});
