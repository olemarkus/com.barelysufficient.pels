import { applyShedTemperatureHold, finalizePlanDevices, normalizeShedReasons } from '../lib/plan/planReasons';
import { NEUTRAL_STARTUP_HOLD_REASON } from '../lib/plan/planRestoreDevices';
import { createPlanEngineState } from '../lib/plan/planState';
import { buildPlanDevice } from './utils/planTestUtils';
import { legacyDeviceReason, reasonText } from './utils/deviceReasonTestUtils';

describe('normalizeShedReasons', () => {
  it('normalizes placeholder reasons to the mapped shed reason', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-1',
        plannedState: 'shed',
        reason: 'restore (need 1.20kW)',
      })],
      shedReasons: new Map([['dev-1', legacyDeviceReason('shed due to hourly budget')!]]),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });

    expect(reasonText(device?.reason)).toBe('shed due to hourly budget');
  });

  it('preserves swap reasons instead of replacing them with cooldown text', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        plannedState: 'shed',
        reason: 'swapped out for Water Heater',
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: true,
      activeOvershoot: false,
      shedCooldownRemainingSec: 25,
    });

    expect(reasonText(device?.reason)).toBe('swapped out for Water Heater');
  });

  it('applies a shortfall reason only when the current reason is generic', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        plannedState: 'shed',
        reason: 'keep',
        expectedPowerKw: 1,
      })],
      shedReasons: new Map(),
      guardInShortfall: true,
      headroomRaw: 0.15,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });

    expect(reasonText(device?.reason)).toBe('shortfall (need 1.20kW, headroom 0.15kW)');
  });

  it('does not replace budget reasons with shortfall text', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        plannedState: 'shed',
        reason: 'shed due to daily budget',
        expectedPowerKw: 1,
      })],
      shedReasons: new Map(),
      guardInShortfall: true,
      headroomRaw: 0.15,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });

    expect(reasonText(device?.reason)).toBe('shed due to daily budget');
  });

  it('does not rewrite capacity shed reasons during restore cooldown for another device', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-1',
        plannedState: 'shed',
        reason: 'shed due to capacity',
      })],
      shedReasons: new Map([['dev-1', legacyDeviceReason('shed due to capacity')!]]),
      guardInShortfall: false,
      headroomRaw: 1.5,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });

    expect(reasonText(device?.reason)).toBe('shed due to capacity');
  });

  it('preserves neutral startup holds during shed cooldown normalization', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-neutral',
        plannedState: 'shed',
        reason: NEUTRAL_STARTUP_HOLD_REASON,
      })],
      shedReasons: new Map(),
      guardInShortfall: false,
      headroomRaw: 0,
      inCooldown: true,
      activeOvershoot: false,
      shedCooldownRemainingSec: 25,
    });

    expect(device?.reason).toEqual(NEUTRAL_STARTUP_HOLD_REASON);
  });

  it('preserves neutral startup holds during shortfall normalization', () => {
    const [device] = normalizeShedReasons({
      planDevices: [buildPlanDevice({
        id: 'dev-neutral',
        plannedState: 'shed',
        reason: NEUTRAL_STARTUP_HOLD_REASON,
        expectedPowerKw: 1,
      })],
      shedReasons: new Map(),
      guardInShortfall: true,
      headroomRaw: 0.15,
      inCooldown: false,
      activeOvershoot: false,
      shedCooldownRemainingSec: null,
    });

    expect(device?.reason).toEqual(NEUTRAL_STARTUP_HOLD_REASON);
  });
});

describe('finalizePlanDevices', () => {
  it('strips candidate reasons before returning finalized plan devices', () => {
    const finalized = finalizePlanDevices([buildPlanDevice({
      plannedState: 'keep',
      reason: 'keep',
      candidateReasons: {
        offStateAnalysis: 'restore (need 1.20kW, headroom 0.30kW)',
      },
    })]);

    expect(finalized.planDevices[0]).not.toHaveProperty('candidateReasons');
  });

  it('allows finalized keep devices to omit a reason', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'keep',
      reason: undefined,
    })])).not.toThrow();
  });

  it('throws in tests when a final reason/state pair is not allowed', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      reason: 'restore (need 1.20kW, headroom 0.30kW)',
    })])).toThrow(/Invalid plan reason pair/);
  });

  it('allows legacy restore cooldown shed reasons that are still emitted by stay-off paths', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'shed',
      reason: 'cooldown (restore, 30s remaining)',
    })])).not.toThrow();
  });

  it('allows legacy restore cooldown keep reasons that still surface during restore holds', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'keep',
      reason: 'cooldown (restore, 30s remaining)',
    })])).not.toThrow();
  });

  it('allows restore pending reasons for keep devices that are waiting on stepped confirmation', () => {
    expect(() => finalizePlanDevices([buildPlanDevice({
      plannedState: 'keep',
      reason: 'restore pending (30s remaining)',
    })])).not.toThrow();
  });
});

describe('applyShedTemperatureHold', () => {
  it('keeps existing special shed reasons while temperature hold is active', () => {
    const state = createPlanEngineState();

    const result = applyShedTemperatureHold({
      planDevices: [buildPlanDevice({
        id: 'dev-temp',
        name: 'Thermostat',
        currentState: 'keep',
        plannedState: 'shed',
        currentTarget: 16,
        plannedTarget: 16,
        currentOn: true,
        shedAction: 'set_temperature',
        shedTemperature: 16,
        reason: 'swap pending',
      })],
      state,
      shedReasons: new Map(),
      inShedWindow: true,
      inCooldown: false,
      activeOvershoot: false,
      availableHeadroom: 1,
      restoredOneThisCycle: false,
      restoredThisCycle: new Set(),
      shedCooldownRemainingSec: null,
      holdDuringRestoreCooldown: false,
      restoreCooldownSeconds: 60,
      restoreCooldownRemainingSec: null,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16, stepId: null }),
    });

    expect(reasonText(result.planDevices[0]?.reason)).toBe('swap pending');
    expect(result.planDevices[0]?.plannedTarget).toBe(16);
  });

  it('preserves neutral startup holds for set_temperature devices', () => {
    const state = createPlanEngineState();

    const result = applyShedTemperatureHold({
      planDevices: [buildPlanDevice({
        id: 'dev-temp',
        name: 'Thermostat',
        currentState: 'off',
        plannedState: 'shed',
        currentTarget: 21,
        plannedTarget: 21,
        currentOn: false,
        shedAction: 'set_temperature',
        shedTemperature: 16,
        reason: NEUTRAL_STARTUP_HOLD_REASON,
      })],
      state,
      shedReasons: new Map(),
      inShedWindow: true,
      inCooldown: false,
      activeOvershoot: false,
      availableHeadroom: 1,
      restoredOneThisCycle: false,
      restoredThisCycle: new Set(),
      shedCooldownRemainingSec: null,
      holdDuringRestoreCooldown: false,
      restoreCooldownSeconds: 60,
      restoreCooldownRemainingSec: null,
      getShedBehavior: () => ({ action: 'set_temperature' as const, temperature: 16, stepId: null }),
    });

    expect(result.planDevices[0]?.reason).toEqual(NEUTRAL_STARTUP_HOLD_REASON);
    expect(result.planDevices[0]?.plannedTarget).toBe(21);
  });
});
