import { describe, expect, it } from 'vitest';
import { PriceLevel } from '../../lib/price/priceLevels';
import { buildPlanCycleObject } from '../utils/planContextPowerFixture';
import type { PlanDevicesDeps } from '../../lib/plan/planDevices';
import { createPlanEngineState } from '../utils/planEngineStateFixture';
import { createPendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import { buildInitialPlanDevicesForSpec, buildPlanInputDevice } from '../utils/planTestUtils';

// The plan device carries the price shift behind its planned target, resolved
// from the same setpoints the planner commanded, so the card's reason line
// ("Raised while power is cheap") says exactly what the plan did.

const DEVICE_ID = 'heater';
const MODE_C = 21;

const settings = (cheapDelta: number) => ({
  [DEVICE_ID]: { enabled: true, cheapDelta, expensiveDelta: -2, surplusWilling: false, surplusDelta: 0 },
});

const planDevice = (params: { level: PriceLevel; cheapDelta?: number; deadlineFloorTargetC?: number }) => {
  const priceSettings = settings(params.cheapDelta ?? 2);
  const context = buildPlanCycleObject({
    devices: [
      buildPlanInputDevice({
        id: DEVICE_ID,
        name: 'Panel heater',
        deviceType: 'temperature',
        currentTemperature: 20,
        expectedPowerKw: 1,
        targets: [{ id: 'target_temperature', value: MODE_C, unit: 'C', min: 5, max: 30, step: 0.5 }],
        ...(params.deadlineFloorTargetC === undefined ? {} : { deadlineFloorTargetC: params.deadlineFloorTargetC }),
      }),
    ],
    intent: {
      getModeDeviceTargets: () => ({ Home: { [DEVICE_ID]: MODE_C } }),
      getPriceOptimizationEnabled: () => true,
      getPriceOptimizationSettings: () => priceSettings,
      getCurrentHourPriceLevel: () => params.level,
    },
    total: 2,
    softLimit: 10,
    headroomRaw: 8,
    headroom: 8,
  });
  const deps: PlanDevicesDeps = {
    getInferredSurplusKw: () => 0,
    getShedBehavior: () => ({ action: 'turn_off' }),
    getPriceOptimizationSettings: () => priceSettings,
    pendingBinaryCommandStore: createPendingBinaryCommandStore({}),
  };
  return buildInitialPlanDevicesForSpec({ context, state: createPlanEngineState(), deps })[0];
};

describe('the price shift behind a planned target', () => {
  it('is carried on the plan device when the kept setpoint is what the plan commands', () => {
    expect(planDevice({ level: PriceLevel.CHEAP })?.priceTargetShift)
      .toEqual({ kind: 'shifted', direction: 'raised', priceLevel: 'cheap' });
    expect(planDevice({ level: PriceLevel.EXPENSIVE })?.priceTargetShift)
      .toEqual({ kind: 'shifted', direction: 'lowered', priceLevel: 'expensive' });
  });

  it('is none on a normal hour, and when the smart-task floor sets the target', () => {
    expect(planDevice({ level: PriceLevel.NORMAL })?.priceTargetShift).toEqual({ kind: 'none' });
    expect(planDevice({ level: PriceLevel.CHEAP, deadlineFloorTargetC: 25 })?.priceTargetShift)
      .toEqual({ kind: 'none' });
  });
});
