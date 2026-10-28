import { describe, expect, it } from 'vitest';
import { resolveOperatingPowerRange } from '../../lib/device/operatingPowerRange';
import { resolveTargetPowerReportedStepId, resolveTargetPowerSteppedControl } from '../../lib/device/nativeSteppedLoadWiring';
import { isOperatingPowerHeldDevice, resolveOperatingPowerHold } from '../../lib/plan/shedding/operatingPowerHold';
import { buildPlanInputDevice } from '../utils/planTestUtils';

describe('operating power restrictions', () => {
  it('keeps the physical minimum distinct from a smaller owner ceiling', () => {
    const config = { preset: 'ev_charger_1_phase' as const, max: 1150 };
    const control = resolveTargetPowerSteppedControl(config, 7360);
    expect(control?.profile.steps.map((step) => step.planningPowerW)).toEqual([0, 1380]);
    expect(resolveOperatingPowerRange({ targetPowerConfig: config, steppedLoadProfile: control?.profile }))
      .toBe('below_minimum');
    expect(resolveOperatingPowerRange({ targetPowerConfig: { ...config, max: 1380 }, steppedLoadProfile: control?.profile }))
      .toBe('usable');
  });

  it('keeps an out-of-range report distinct from the sole allowed active rung', () => {
    const profile = { steps: [{ id: 'off', planningPowerW: 0 }, { id: '6a', planningPowerW: 1380 }] };
    expect(resolveTargetPowerReportedStepId({ profile, capabilityObj: { target_power: { value: 7360 } } })).toBe('7360w');
    expect(resolveTargetPowerReportedStepId({ profile, capabilityObj: { target_power: { value: 1380 } } })).toBe('6a');
  });

  it('keeps a task-driven device held when its configured ceiling cannot support the minimum', () => {
    const device = buildPlanInputDevice({
      operatingPowerRange: 'below_minimum', control: { managed: true, commandAuthority: true },
      startPolicyHoldLifted: true, chargeTargetHoldLifted: true,
    });
    expect(isOperatingPowerHeldDevice(device)).toBe(true);
    expect(resolveOperatingPowerHold([device]).holdIds.has(device.id)).toBe(true);
  });

  it('does not gain authority over a device PELS only watches', () => {
    const device = buildPlanInputDevice({
      operatingPowerRange: 'below_minimum', control: { managed: true, commandAuthority: false },
    });
    expect(resolveOperatingPowerHold([device]).holdIds.size).toBe(0);
  });
});
