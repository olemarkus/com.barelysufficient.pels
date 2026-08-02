import {
  formatStepDisplayLabel,
  isSteppedTransit,
  resolveSteppedActiveStepId,
  resolveSteppedEvExceptionLabel,
  resolveSteppedLevelFact,
  resolveSteppedStatusLine,
  resolveSteppedTemperatureText,
} from '../../shared-domain/src/planSteppedCardText.ts';
import {
  PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
  PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS,
  PLAN_STATE_HELD_FALLBACK_STATUS,
} from '../../shared-domain/src/planStateLabels.ts';
import type { SteppedLoadProfile } from '../../contracts/src/types.ts';
import type { SettingsUiPlanDeviceStarvation } from '../../contracts/src/settingsUiApi.ts';

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

describe('resolveSteppedLevelFact', () => {
  it('returns null when the device is off (the bold state word covers off)', () => {
    expect(resolveSteppedLevelFact({ ...baseDevice, currentState: 'off' })).toBeNull();
    expect(resolveSteppedLevelFact({ ...baseDevice, currentState: 'unknown' })).toBeNull();
    expect(resolveSteppedLevelFact({})).toBeNull();
  });

  it('names the level when at a powered step', () => {
    expect(resolveSteppedLevelFact({
      ...baseDevice, currentState: 'on', steppedLoad: steppedLoad({ reportedStepId: 'low' }),
    })).toBe('Level Low');
  });

  it('shows "Level unknown" without a reported step (no fallback/assumed leakage)', () => {
    // Only the typed `steppedLoad.reportedStepId` is observed UI truth; a device
    // with no reported step must not infer a level from any other field.
    expect(resolveSteppedLevelFact({
      ...baseDevice, currentState: 'on',
    })).toBe('Level unknown');
  });

  it('renders ampere step ids in SI form ("6 A", not "6a")', () => {
    expect(resolveSteppedLevelFact({
      ...baseDevice, currentState: 'on', steppedLoad: steppedLoad({ reportedStepId: '6a' }),
    })).toBe('Level 6 A');
  });

  it('folds a routinely-charging EV into "Charging · level N A"', () => {
    expect(resolveSteppedLevelFact({
      ...baseDevice,
      currentState: 'on',
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_charging',
      steppedLoad: steppedLoad({ reportedStepId: '16a' }),
    })).toBe('Charging · level 16 A');
  });
});

describe('resolveSteppedEvExceptionLabel', () => {
  it('is null for non-EV devices and for routine charging', () => {
    expect(resolveSteppedEvExceptionLabel({})).toBeNull();
    expect(resolveSteppedEvExceptionLabel({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_charging',
    })).toBeNull();
  });

  it('surfaces the exceptional EV states for the reason slot', () => {
    expect(resolveSteppedEvExceptionLabel({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_out',
    })).toBe('Unplugged');
    expect(resolveSteppedEvExceptionLabel({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in_paused',
    })).toBe('Paused');
  });

  it('reads "Not charging" for a plugged-in idle charger PELS is not commanding', () => {
    // No plan target at all — PELS left the charger idle; the car (which
    // cannot initiate charging past an idle setpoint) must not be blamed.
    expect(resolveSteppedEvExceptionLabel({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in',
    })).toBe('Not charging');
    // An explicit off / zero-watt target is equally PELS-idled.
    expect(resolveSteppedEvExceptionLabel({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in',
      steppedLoad: { ...steppedLoad({ targetStepId: 'off' }), profile: profileWithOff },
    })).toBe('Not charging');
  });

  it('reads "Waiting for car" only when a powered step is commanded and the car does not draw', () => {
    expect(resolveSteppedEvExceptionLabel({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in',
      steppedLoad: { ...steppedLoad({ targetStepId: 'low' }), profile: profileWithOff },
    })).toBe('Waiting for car');
    // Without a profile, a non-off target id is the best available evidence
    // of a charge command.
    expect(resolveSteppedEvExceptionLabel({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in',
      steppedLoad: steppedLoad({ targetStepId: '16a' }),
    })).toBe('Waiting for car');
  });

  it('never blames the car in simulation — the powered target is hypothetical intent', () => {
    expect(resolveSteppedEvExceptionLabel({
      controlCapabilityId: 'evcharger_charging',
      evChargingState: 'plugged_in',
      steppedLoad: { ...steppedLoad({ targetStepId: 'low' }), profile: profileWithOff },
    }, true)).toBe('Not charging');
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

describe('resolveSteppedStatusLine', () => {
  describe('stable — no status line', () => {
    it('returns null when on track with no target (quiet state, no filler line)', () => {
      expect(resolveSteppedStatusLine(
        { ...baseDevice, currentState: 'on', steppedLoad: steppedLoad({ reportedStepId: 'low' }) },
        profile,
        NOW_MS,
      )).toBeNull();
    });

    it('returns null when target matches current step (quiet state, no filler line)', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'low', targetStepId: 'low' }),
        },
        profile,
        NOW_MS,
      )).toBeNull();
    });

    it('returns null when off and no target', () => {
      expect(resolveSteppedStatusLine(
        { ...baseDevice, currentState: 'off' },
        profile,
        NOW_MS,
      )).toBeNull();
    });

    it('explains when the device was turned off elsewhere', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          reason: { code: 'external_off_hold' },
        },
        profile,
        NOW_MS,
      )).toBe(PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS);
    });

    it('suppresses stale external-off guidance when the device is unavailable', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          stateKind: 'unavailable',
          reason: { code: 'external_off_hold' },
        },
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

    it('returns null (quiet) when reported step equals target step (boost-driven settling)', () => {
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
      expect(result).toBeNull();
    });

    it('returns null (quiet) when reported step equals target step and reason is headroomCooldown', () => {
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
      expect(result).toBeNull();
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

    // Production-shaped reason (margins present): the gap is the
    // admission-accurate shortfall `minimumRequired − postReserveMargin`
    // (0.25 − (−0.75) = 1.0 kW), NOT the understated `need − available`
    // (1.2 − 0.7 = 0.5 kW). Prod 2026-08-01: cards claimed "0.5 kW more
    // needed" for a device admission would only pass with ~1.0 kW more.
    it('renders the admission-accurate shortfall when reserve margins are present', () => {
      const result = resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          steppedLoad: steppedLoad({ targetStepId: 'low' }),
          reason: {
            code: 'insufficient_headroom',
            needKw: 1.2,
            availableKw: 0.7,
            effectiveAvailableKw: null,
            postReserveMarginKw: -0.75,
            minimumRequiredPostReserveMarginKw: 0.25,
            penaltyExtraKw: null,
            swapReserveKw: null,
            swapTargetName: null,
          },
        },
        profile,
        NOW_MS,
      );
      expect(result).toBe('Waiting to resume — 1.0 kW more needed');
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

    // The hard cap is a house-level fact the hero names once (and not a lever
    // the owner can trade against), so a capacity hold with no resolved
    // shortfall says only that the device is waiting.
    it('returns the bare waiting line when held off with a capacity reason and no gap info', () => {
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

    it('states the shortfall when a budget hold carries one', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'off',
          steppedLoad: steppedLoad({ targetStepId: 'low' }),
          reason: { code: 'daily_budget', detail: null, shortfallKw: 0.6 },
        },
        profile,
        NOW_MS,
      )).toBe('Waiting to resume — 0.6 kW more needed');
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

    // The invariant only refuses step INCREASES, so the line says where the
    // device is holding and what would lift it — never "blocked", and never the
    // invariant's `maxStep` cap, which is not where the device is (prod
    // 2026-07-05 claimed "Limited to Low" for a device running at Medium).
    it('names the device step and the devices whose resume would lift the hold', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          reportedStepId: 'medium',
          reason: { code: 'shed_invariant', fromStep: 'medium', toStep: 'high', shedDeviceCount: 1, maxStep: 'low' },
        },
        profile,
        NOW_MS,
      )).toBe('Holding at Medium — cannot increase while 1 device is limited');
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
      )).toBe('Holding at Low — cannot increase while 3 devices are limited');
    });

    it('returns null when desired step is lower with no reason (quiet, no filler line)', () => {
      expect(resolveSteppedStatusLine(
        {
          ...baseDevice,
          currentState: 'on',
          steppedLoad: steppedLoad({ reportedStepId: 'max', targetStepId: 'low' }),
          reason: { code: 'none' },
        },
        profile,
        NOW_MS,
      )).toBeNull();
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
      .toBe('20.5 °C · target 50 °C');
  });

  it('returns null when currentTemperature is absent', () => {
    expect(resolveSteppedTemperatureText({ plannedTarget: 50 })).toBeNull();
  });

  it('returns null when plannedTarget is absent', () => {
    expect(resolveSteppedTemperatureText({ currentTemperature: 20.5 })).toBeNull();
  });

  it('rounds target temperature to integer', () => {
    expect(resolveSteppedTemperatureText({ currentTemperature: 37.2, plannedTarget: 49.8 }))
      .toBe('37.2 °C · target 50 °C');
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

describe('resolveSteppedStatusLine — budget hold vs active recovery', () => {
  const budgetHeld: SettingsUiPlanDeviceStarvation = {
    isStarved: true,
    accumulatedMs: 60_000,
    cause: 'budget',
    startedAtMs: NOW_MS - 60_000,
  };

  it('shows the budget line for a budget-held device that is not moving', () => {
    const result = resolveSteppedStatusLine(
      {
        ...baseDevice,
        currentState: 'off',
        steppedLoad: steppedLoad({ reportedStepId: 'off', commandPending: false }),
        starvation: budgetHeld,
      },
      profileWithOff,
      NOW_MS,
    );
    expect(result).toBe("Limited to stay within today's budget");
  });

  it('lets an in-flight step command win over the latched budget hold during recovery', () => {
    // After a budget device is commanded back up, diagnostics keeps `isStarved`
    // latched through the clear window; the status line must show the transit
    // state, not the stale budget hold.
    const transiting = {
      ...baseDevice,
      currentState: 'on',
      steppedLoad: steppedLoad({ reportedStepId: 'low', targetStepId: 'max', commandPending: true }),
      starvation: budgetHeld,
    };
    const withBudget = resolveSteppedStatusLine(transiting, profile, NOW_MS);
    const withoutBudget = resolveSteppedStatusLine({ ...transiting, starvation: undefined }, profile, NOW_MS);
    expect(withBudget).not.toBe("Limited to stay within today's budget");
    expect(withBudget).toBe(withoutBudget);
  });

  it('stays neutral for a suppressed at-target settling latch even while budget-starved', () => {
    // A headroom-check settling that is suppressed because the device is AT target
    // is a recovery latch — it must read quiet (no status line), never the
    // latched budget hold.
    const result = resolveSteppedStatusLine(
      {
        ...baseDevice,
        currentState: 'on',
        steppedLoad: steppedLoad({ reportedStepId: 'medium', targetStepId: 'medium' }),
        reason: { code: 'meter_settling', remainingSec: 14 },
        starvation: budgetHeld,
      },
      profile,
      NOW_MS,
    );
    expect(result).toBeNull();
  });
});
