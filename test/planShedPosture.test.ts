import { describe, expect, it } from 'vitest';
import { hasPlannedShedDevices } from '../lib/plan/planShedPosture';
import type { DevicePlan } from '../lib/plan/planTypes';
import { legacyDeviceReason } from './utils/deviceReasonTestUtils';

const keepReason = legacyDeviceReason('keep')!;
const shedReason = legacyDeviceReason('shed due to capacity')!;

const planWithDevices = (devices: DevicePlan['devices']): DevicePlan => ({
  meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
  devices,
});

const device = (overrides: Partial<DevicePlan['devices'][number]> = {}): DevicePlan['devices'][number] => ({
  id: 'dev-1',
  name: 'Device',
  currentState: 'on',
  plannedState: 'keep',
  currentTarget: null,
  plannedTarget: null,
  controllable: true,
  reason: keepReason,
  ...overrides,
});

describe('planShedPosture', () => {
  it('detects planned shed posture independent of executable commandability', () => {
    const plan = planWithDevices([
      device({
        plannedState: 'shed',
        reason: shedReason,
        controlModel: 'stepped_load',
        steppedLoadProfile: {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
          ],
        },
        shedAction: 'set_step',
        selectedStepId: undefined,
        desiredStepId: undefined,
      }),
    ]);

    expect(hasPlannedShedDevices(plan)).toBe(true);
  });

  it('returns false when the plan has no shed posture', () => {
    expect(hasPlannedShedDevices(planWithDevices([device()]))).toBe(false);
  });
});
