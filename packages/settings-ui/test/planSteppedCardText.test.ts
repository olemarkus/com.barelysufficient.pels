import {
  isSteppedTransit,
  resolveSteppedActiveStepId,
  resolveSteppedChip,
  resolveSteppedStateLabel,
  resolveSteppedStatusLine,
  resolveSteppedTemperatureText,
} from '../../shared-domain/src/planSteppedCardText.ts';
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

  it('does not use actualStepId as observed UI truth', () => {
    expect(resolveSteppedStateLabel({
      ...baseDevice, currentState: 'on', actualStepId: 'medium',
    })).toBe('Level unknown');
  });

  it('capitalizes step id', () => {
    expect(resolveSteppedStateLabel({
      ...baseDevice, currentState: 'on', steppedLoad: steppedLoad({ reportedStepId: 'max' }),
    })).toBe('Level: Max');
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

  it('returns Settling chip for headroomCooldown reason', () => {
    expect(resolveSteppedChip({
      ...baseDevice,
      reason: { code: 'headroom_cooldown', kind: 'recent_pels_restore', remainingSec: 30, fromKw: null, toKw: null, countdownStartedAtMs: NOW_MS - 5000 },
    })).toEqual({ label: 'Settling', tone: 'warn' });
  });

  it('returns Settling chip for meterSettling reason', () => {
    expect(resolveSteppedChip({
      ...baseDevice,
      reason: { code: 'meter_settling', remainingSec: 10 },
    })).toEqual({ label: 'Settling', tone: 'warn' });
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
      expect(result).toBe('Resumed 10s ago — confirming no overshoot');
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
      expect(result).toBe('Recently reduced · can increase in 42s');
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
      expect(result).toBe('Resumed 7s ago — confirming no overshoot');
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
      expect(result).toBe('Recently reduced · can increase in 15s');
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
      expect(result).toBe('Waiting for meter reading (8s)');
    });
  });

  describe('blocked — not in transit', () => {
    it('returns "Needs X kW more to turn on" when off and blocked by insufficient headroom', () => {
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
      expect(result).toBe('Needs 0.4 kW more to turn on');
    });

    it('returns "Needs X kW more to increase" when on at low and blocked from medium', () => {
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
      expect(result).toBe('Needs 0.5 kW more to increase');
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
      expect(result).toBe('Needs 0.3 kW more to turn on');
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
      )).toBe('Off to stay within budget');
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
      )).toBe('Capped at Low — 1 device still shed');
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
      )).toBe('Capped at Low — 3 devices still shed');
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

  it('returns null when plannedTarget is null', () => {
    expect(resolveSteppedTemperatureText({ currentTemperature: 20.5, plannedTarget: null }))
      .toBeNull();
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
