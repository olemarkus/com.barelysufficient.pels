import {
  isSteppedTransit,
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
      ...baseDevice, currentState: 'on', reportedStepId: 'low',
    })).toBe('Level: Low');
  });

  it('returns "Level: Medium" from actualStepId when no reportedStepId', () => {
    expect(resolveSteppedStateLabel({
      ...baseDevice, currentState: 'on', actualStepId: 'medium',
    })).toBe('Level: Medium');
  });

  it('capitalizes step id', () => {
    expect(resolveSteppedStateLabel({
      ...baseDevice, currentState: 'on', reportedStepId: 'max',
    })).toBe('Level: Max');
  });
});

describe('isSteppedTransit', () => {
  it('returns false with no pending signals', () => {
    expect(isSteppedTransit({})).toBe(false);
  });

  it('returns true when binaryCommandPending is true', () => {
    expect(isSteppedTransit({ binaryCommandPending: true })).toBe(true);
  });

  it('returns true when pendingTargetCommand is set', () => {
    expect(isSteppedTransit({ pendingTargetCommand: { desired: 1, retryCount: 0 } })).toBe(true);
  });

  it('returns false when binaryCommandPending is false', () => {
    expect(isSteppedTransit({ binaryCommandPending: false })).toBe(false);
  });
});

describe('resolveSteppedChip', () => {
  it('returns Applying chip when in transit', () => {
    expect(resolveSteppedChip({ ...baseDevice, binaryCommandPending: true }))
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

  it('returns Limited chip for insufficientHeadroom reason', () => {
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
    })).toEqual({ label: 'Limited', tone: 'warn' });
  });

  it('returns Limited chip for capacity reason', () => {
    expect(resolveSteppedChip({
      ...baseDevice,
      reason: { code: 'capacity', detail: null },
    })).toEqual({ label: 'Limited', tone: 'warn' });
  });

  it('returns null when stable with no constraints', () => {
    expect(resolveSteppedChip({ ...baseDevice })).toBeNull();
  });
});

describe('resolveSteppedStatusLine', () => {
  describe('stable — no status line', () => {
    it('returns "Maintaining level" when on track with no target', () => {
      expect(resolveSteppedStatusLine(
        { ...baseDevice, currentState: 'on', reportedStepId: 'low' },
        profile,
        NOW_MS,
      )).toBe('Maintaining level');
    });

    it('returns "Maintaining level" when target matches current step', () => {
      expect(resolveSteppedStatusLine(
        { ...baseDevice, currentState: 'on', reportedStepId: 'low', desiredStepId: 'low' },
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
          reportedStepId: 'low',
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
      expect(result).toBe('Restored 10s ago — confirming no overshoot');
    });

    it('returns countdown for recent_pels_shed kind', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          reportedStepId: 'low',
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
          reportedStepId: 'low',
          reason: { code: 'cooldown_restore', remainingSec: 20, countdownStartedAtMs: NOW_MS - 7_000 },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Restored 7s ago — confirming no overshoot');
    });

    it('returns countdown for cooldownShedding reason', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          reportedStepId: 'low',
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
          reportedStepId: 'low',
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
          desiredStepId: 'low',
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
          reportedStepId: 'low',
          desiredStepId: 'medium',
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
          desiredStepId: 'low',
          reason: { code: 'shortfall', needKw: 1.25, headroomKw: 0.95 },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Needs 0.3 kW more to turn on');
    });

    it('returns null when held but reason has no gap info', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          desiredStepId: 'low',
          reason: { code: 'capacity', detail: null },
        },
        profile,
        NOW_MS,
      )).toBeNull();
    });

    it('returns null when desired step is lower (being shed down, chip covers it)', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          reportedStepId: 'max',
          desiredStepId: 'low',
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
          targetStepId: 'low',
          binaryCommandPending: true,
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
          reportedStepId: 'low',
          targetStepId: 'medium',
          binaryCommandPending: true,
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
          reportedStepId: 'max',
          targetStepId: 'low',
          pendingTargetCommand: { desired: 1, retryCount: 0, nextRetryAtMs: 0, status: 'waiting_confirmation' as const },
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
          reportedStepId: 'low',
          targetStepId: 'off',
          binaryCommandPending: true,
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
          targetStepId: 'low',
          binaryCommandPending: true,
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
