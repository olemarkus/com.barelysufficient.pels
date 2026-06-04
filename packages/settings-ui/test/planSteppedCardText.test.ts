import {
  formatStepDisplayLabel,
  isSteppedTransit,
  resolveSteppedActiveStepId,
  resolveSteppedChip,
  resolveSteppedStateLabel,
  resolveSteppedStatusLine,
  resolveSteppedTemperatureText,
} from '../../shared-domain/src/planSteppedCardText.ts';
import {
  PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
  PLAN_STATE_HELD_FALLBACK_STATUS,
} from '../../shared-domain/src/planStateLabels.ts';
import type { SteppedLoadProfile } from '../../contracts/src/types.ts';

const NOW_MS = 1_000_000;

const profile: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 1750 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const profileWithOff: SteppedLoadProfile = {
  model: 'stepped_load',
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: 'low', planningPowerW: 1250 },
    { id: 'medium', planningPowerW: 1750 },
    { id: 'max', planningPowerW: 3000 },
  ],
};

const baseDevice = {
  reason: { code: 'none' as const },
};

const steppedLoad = (
  overrides: Partial<{ reportedStepId: string | null; targetStepId: string | null; commandPending: boolean }> = {},
) => ({
  reportedStepId: null,
  targetStepId: null,
  commandPending: false,
  ...overrides,
});

describe('resolveSteppedStateLabel', () => {
  it('returns "Off now" when currentState is off', () => {
    expect(resolveSteppedStateLabel({ ...baseDevice, currentState: 'off' })).toBe('Off now');
  });

  it('returns "Off now" when currentState is unknown', () => {
    expect(resolveSteppedStateLabel({ ...baseDevice, currentState: 'unknown' })).toBe('Off now');
  });

  it('returns "Off now" when currentState is absent', () => {
    expect(resolveSteppedStateLabel({ ...baseDevice })).toBe('Off now');
  });

  it('returns "Level: Low" when at low step', () => {
    expect(resolveSteppedStateLabel({
      ...baseDevice, currentState: 'on', steppedLoad: steppedLoad({ reportedStepId: 'low' }),
    })).toBe('Level: Low');
  });

  it('shows "Level unknown" without a reported step (no fallback/assumed leakage)', () => {
    // Only the typed `steppedLoad.reportedStepId` is observed UI truth; a device
    // with no reported step must not infer a level from any other field.
    expect(resolveSteppedStateLabel({
      ...baseDevice, currentState: 'on',
    })).toBe('Level unknown');
  });

  it('capitalizes step id', () => {
    expect(resolveSteppedStateLabel({
      ...baseDevice, currentState: 'on', steppedLoad: steppedLoad({ reportedStepId: 'max' }),
    })).toBe('Level: Max');
  });

  it('renders ampere step ids in SI form ("6 A", not "6a")', () => {
    expect(resolveSteppedStateLabel({
      ...baseDevice, currentState: 'on', steppedLoad: steppedLoad({ reportedStepId: '6a' }),
    })).toBe('Level: 6 A');
    expect(resolveSteppedStateLabel({
      ...baseDevice, currentState: 'on', steppedLoad: steppedLoad({ reportedStepId: '32a' }),
    })).toBe('Level: 32 A');
  });
});

describe('formatStepDisplayLabel', () => {
  it('formats ampere step ids as "N A" so they cannot read as "6 am"', () => {
    expect(formatStepDisplayLabel('6a')).toBe('6 A');
    expect(formatStepDisplayLabel('16a')).toBe('16 A');
    expect(formatStepDisplayLabel('32a')).toBe('32 A');
  });

  it('also accepts an already-uppercase ampere suffix', () => {
    expect(formatStepDisplayLabel('6A')).toBe('6 A');
  });

  it('capitalizes non-ampere step ids', () => {
    expect(formatStepDisplayLabel('off')).toBe('Off');
    expect(formatStepDisplayLabel('low')).toBe('Low');
    expect(formatStepDisplayLabel('medium')).toBe('Medium');
    expect(formatStepDisplayLabel('high')).toBe('High');
  });

  it('leaves bare numeric ids alone (no ampere suffix → no unit)', () => {
    expect(formatStepDisplayLabel('1')).toBe('1');
    expect(formatStepDisplayLabel('100')).toBe('100');
  });

  it('returns empty string for empty input', () => {
    expect(formatStepDisplayLabel('')).toBe('');
    expect(formatStepDisplayLabel('   ')).toBe('');
  });
});

describe('isSteppedTransit', () => {
  it('returns false with no pending signals', () => {
    expect(isSteppedTransit({})).toBe(false);
  });

  it('returns true when stepped-load command is pending', () => {
    expect(isSteppedTransit({ steppedLoad: steppedLoad({ commandPending: true }) })).toBe(true);
  });

  it('returns false when commandPending is false', () => {
    expect(isSteppedTransit({ steppedLoad: steppedLoad({ commandPending: false }) })).toBe(false);
  });
});

describe('resolveSteppedChip', () => {
  it('returns Applying chip when in transit', () => {
    expect(resolveSteppedChip({ ...baseDevice, steppedLoad: steppedLoad({ commandPending: true }) }))
      .toEqual({ label: 'Applying', tone: 'ok' });
  });

  it('returns null for headroomCooldown reason (status line covers it)', () => {
    expect(resolveSteppedChip({
      ...baseDevice,
      reason: { code: 'headroom_cooldown', kind: 'recent_pels_restore', remainingSec: 30, fromKw: null, toKw: null, countdownStartedAtMs: NOW_MS - 5000 },
    })).toBeNull();
  });

  it('returns null for meterSettling reason (status line covers it)', () => {
    expect(resolveSteppedChip({
      ...baseDevice,
      reason: { code: 'meter_settling', remainingSec: 10 },
    })).toBeNull();
  });

  it('returns null for shedInvariant reason (bar colour covers it)', () => {
    expect(resolveSteppedChip({
      ...baseDevice,
      reason: { code: 'shed_invariant', fromStep: 'low', toStep: 'medium', shedDeviceCount: 2, maxStep: 'low' },
    })).toBeNull();
  });

  it('returns null for insufficientHeadroom reason (bar colour covers it)', () => {
    expect(resolveSteppedChip({
      ...baseDevice,
      reason: {
        code: 'insufficient_headroom',
        needKw: 1.25,
        availableKw: 0.5,
        effectiveAvailableKw: 0.5,
        postReserveMarginKw: null,
        minimumRequiredPostReserveMarginKw: null,
        penaltyExtraKw: null,
        swapReserveKw: null,
        swapTargetName: null,
      },
    })).toBeNull();
  });

  it('returns null for capacity reason (bar colour covers it)', () => {
    expect(resolveSteppedChip({
      ...baseDevice,
      reason: { code: 'capacity', detail: null },
    })).toBeNull();
  });

  it('returns null when stable with no constraints', () => {
    expect(resolveSteppedChip({ ...baseDevice })).toBeNull();
  });
});

describe('resolveSteppedStatusLine', () => {
  describe('stable — no status line', () => {
    it('returns "Maintaining level" when on track with no target', () => {
      expect(resolveSteppedStatusLine(
        { ...baseDevice, currentState: 'on', steppedLoad: steppedLoad({ reportedStepId: 'low' }) },
        profile,
        NOW_MS,
      )).toBe('Maintaining level');
    });

    it('returns "Maintaining level" when target matches current step', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low', targetStepId: 'low' }),
        },
        profile,
        NOW_MS,
      )).toBe('Maintaining level');
    });

    it('returns null when off and no target', () => {
      expect(resolveSteppedStatusLine(
        { ...baseDevice, currentState: 'off' },
        profile,
        NOW_MS,
      )).toBeNull();
    });
  });

  describe('settling — headroom cooldown', () => {
    it('returns elapsed text for recent_pels_restore kind', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low' }),
          reason: {
            code: 'headroom_cooldown',
            kind: 'recent_pels_restore',
            remainingSec: 25,
            fromKw: null,
            toKw: null,
            countdownStartedAtMs: NOW_MS - 10_000,
          },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Resumed 10s ago — checking power reading');
    });

    it('returns countdown for recent_pels_shed kind', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low' }),
          reason: {
            code: 'headroom_cooldown',
            kind: 'recent_pels_shed',
            remainingSec: 42,
            fromKw: null,
            toKw: null,
            countdownStartedAtMs: NOW_MS - 5_000,
          },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Limited — will try to resume in 42s if power is available');
    });

    it('returns elapsed text for cooldownRestore reason', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low' }),
          reason: { code: 'cooldown_restore', remainingSec: 20, countdownStartedAtMs: NOW_MS - 7_000 },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Resumed 7s ago — checking power reading');
    });

    it('returns countdown for cooldownShedding reason', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low' }),
          reason: { code: 'cooldown_shedding', remainingSec: 15 },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Limited — will try to resume in 15s if power is available');
    });

    it('returns meter wait text for meterSettling reason', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low' }),
          reason: { code: 'meter_settling', remainingSec: 8 },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Waiting for power meter to stabilise — 8s');
    });

    it('returns "Maintaining level" when reported step equals target step (boost-driven settling)', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'medium', targetStepId: 'medium' }),
          reason: { code: 'meter_settling', remainingSec: 14 },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Maintaining level');
    });

    it('returns "Maintaining level" when reported step equals target step and reason is headroomCooldown', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'medium', targetStepId: 'medium' }),
          reason: {
            code: 'headroom_cooldown',
            kind: 'recent_pels_shed',
            remainingSec: 30,
            fromKw: null,
            toKw: null,
            countdownStartedAtMs: NOW_MS - 5_000,
          },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Maintaining level');
    });

    it('still returns the cooldown countdown for cooldownShedding even when reported step equals target step', () => {
      // cooldown_shedding implies the planner is actively holding the device at a
      // shed step; that hold must remain visible even though reported == target.
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low', targetStepId: 'low' }),
          reason: { code: 'cooldown_shedding', remainingSec: 22 },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Limited — will try to resume in 22s if power is available');
    });

    it('still returns the cooldown elapsed text for cooldownRestore even when reported step equals target step', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'medium', targetStepId: 'medium' }),
          reason: { code: 'cooldown_restore', remainingSec: 18, countdownStartedAtMs: NOW_MS - 4_000 },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Resumed 4s ago — checking power reading');
    });

    it('returns "Briefly holding — Ns" for activationBackoff reason', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low' }),
          reason: { code: 'activation_backoff', remainingSec: 12 },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Briefly holding — 12s');
    });

    it('returns "Queued to resume — Ns" for restorePending reason', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          steppedLoad: steppedLoad({ targetStepId: 'low' }),
          reason: { code: 'restore_pending', remainingSec: 9 },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Queued to resume — 9s');
    });

    it('returns "Holding at startup" for neutralStartupHold reason', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low' }),
          reason: { code: 'neutral_startup_hold' },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Holding at startup');
    });

    it('returns "Stabilising after startup" for startupStabilization reason', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low' }),
          reason: { code: 'startup_stabilization' },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Stabilising after startup');
    });
  });

  describe('blocked — not in transit', () => {
    it('returns waiting-to-resume text when off and blocked by insufficient available power', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          steppedLoad: steppedLoad({ targetStepId: 'low' }),
          reason: {
            code: 'insufficient_headroom',
            needKw: 1.25,
            availableKw: 0.85,
            effectiveAvailableKw: 0.85,
            postReserveMarginKw: null,
            minimumRequiredPostReserveMarginKw: null,
            penaltyExtraKw: null,
            swapReserveKw: null,
            swapTargetName: null,
          },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Waiting to resume — 0.4 kW more needed');
    });

    it('returns waiting-to-increase text when on at low and blocked from medium', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low', targetStepId: 'medium' }),
          reason: {
            code: 'insufficient_headroom',
            needKw: 1.75,
            availableKw: 1.25,
            effectiveAvailableKw: 1.25,
            postReserveMarginKw: null,
            minimumRequiredPostReserveMarginKw: null,
            penaltyExtraKw: null,
            swapReserveKw: null,
            swapTargetName: null,
          },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Waiting to increase — 0.5 kW more needed');
    });

    it('uses shortfall reason headroomKw to compute gap', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          steppedLoad: steppedLoad({ targetStepId: 'low' }),
          reason: { code: 'shortfall', needKw: 1.25, headroomKw: 0.95 },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Waiting to resume — 0.3 kW more needed');
    });

    it('returns budget text when held off with capacity reason and no gap info', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          steppedLoad: steppedLoad({ targetStepId: 'low' }),
          reason: { code: 'capacity', detail: null },
        },
        profile,
        NOW_MS,
      )).toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
    });

    it('returns the deferred-objective avoid status when the smart task is waiting for cheaper hours', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          steppedLoad: steppedLoad({ targetStepId: 'low' }),
          reason: { code: 'deferred_objective_avoid', detail: null },
        },
        profile,
        NOW_MS,
      )).toBe(PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS);
    });

    it('returns shed invariant status with count and max step', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          reportedStepId: 'low',
          reason: { code: 'shed_invariant', fromStep: 'low', toStep: 'medium', shedDeviceCount: 1, maxStep: 'low' },
        },
        profile,
        NOW_MS,
      )).toBe('Limited to Low — 1 device still limited');
    });

    it('returns shed invariant status with plural device count', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          reportedStepId: 'low',
          reason: { code: 'shed_invariant', fromStep: 'low', toStep: 'medium', shedDeviceCount: 3, maxStep: 'low' },
        },
        profile,
        NOW_MS,
      )).toBe('Limited to Low — 3 devices still limited');
    });

    it('returns null when desired step is lower (being shed down, chip covers it)', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'max', targetStepId: 'low' }),
          reason: { code: 'none' },
        },
        profile,
        NOW_MS,
      )).toBe('Maintaining level');
    });
  });

  describe('in transit', () => {
    it('returns "Turning on to Low" when applying first step from off', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          steppedLoad: steppedLoad({ targetStepId: 'low', commandPending: true }),
        },
        profile,
        NOW_MS,
      )).toBe('Turning on to Low');
    });

    it('returns "Increasing to Medium" when stepping up', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low', targetStepId: 'medium', commandPending: true }),
        },
        profile,
        NOW_MS,
      )).toBe('Increasing to Medium');
    });

    it('returns "Reducing to Low" when stepping down', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'max', targetStepId: 'low', commandPending: true }),
        },
        profile,
        NOW_MS,
      )).toBe('Reducing to Low');
    });

    it('returns "Turning off to stay below limit" when target is off step', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low', targetStepId: 'off', commandPending: true }),
        },
        profileWithOff,
        NOW_MS,
      )).toBe('Turning off to stay below limit');
    });

    it('returns "Turning on to Low" when off and target is powered step (profile has Off step)', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          steppedLoad: steppedLoad({ targetStepId: 'low', commandPending: true }),
        },
        profileWithOff,
        NOW_MS,
      )).toBe('Turning on to Low');
    });
  });
});

describe('resolveSteppedTemperatureText', () => {
  it('returns formatted arrow text when both temperatures are present', () => {
    expect(resolveSteppedTemperatureText({ currentTemperature: 20.5, plannedTarget: 50 }))
      .toBe('20.5° → 50°');
  });

  it('returns null when currentTemperature is absent', () => {
    expect(resolveSteppedTemperatureText({ plannedTarget: 50 })).toBeNull();
  });

  it('returns null when plannedTarget is absent', () => {
    expect(resolveSteppedTemperatureText({ currentTemperature: 20.5 })).toBeNull();
  });

  it('rounds target temperature to integer', () => {
    expect(resolveSteppedTemperatureText({ currentTemperature: 37.2, plannedTarget: 49.8 }))
      .toBe('37.2° → 50°');
  });
});

describe('resolveSteppedActiveStepId', () => {
  it('returns the off step id when state is off and profile has an explicit off step', () => {
    const device = { ...baseDevice, currentState: 'off', steppedLoad: steppedLoad({ reportedStepId: 'low' }) };
    expect(resolveSteppedActiveStepId(device, profileWithOff)).toBe('off');
  });

  it('returns synthetic "off" id when state is off-like but profile has no off step', () => {
    const device = { ...baseDevice, currentState: 'off', steppedLoad: steppedLoad({ reportedStepId: 'low' }) };
    expect(resolveSteppedActiveStepId(device, profile)).toBe('off');
  });

  it('returns synthetic "off" id for empty currentState with no off step', () => {
    const device = { ...baseDevice, currentState: '', steppedLoad: steppedLoad({ reportedStepId: 'medium' }) };
    expect(resolveSteppedActiveStepId(device, profile)).toBe('off');
  });

  it('returns reportedStepId when state is not off-like', () => {
    const device = {
      ...baseDevice,
      currentState: 'not_applicable',
      steppedLoad: steppedLoad({ reportedStepId: 'medium' }),
    };
    expect(resolveSteppedActiveStepId(device, profile)).toBe('medium');
  });
});
