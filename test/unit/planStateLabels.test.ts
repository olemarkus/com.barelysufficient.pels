import {
  resolvePlanStateKind,
  resolvePlanStateTone,
} from '../../packages/shared-domain/src/planStateLabels';
import { buildComparablePlanReason } from '../../packages/shared-domain/src/planReasonSemantics';

const baseDevice = {
  reason: buildComparablePlanReason('keep'),
  controllable: true,
  available: true,
  plannedState: 'keep',
};

describe('planStateLabels', () => {
  it('keeps explicit shed plans held when current state is missing', () => {
    expect(resolvePlanStateKind({
      ...baseDevice,
      plannedState: 'shed',
    })).toBe('held');
  });

  it('classifies missing or empty current state as unknown after explicit plan states', () => {
    expect(resolvePlanStateKind(baseDevice)).toBe('unknown');
    expect(resolvePlanStateKind({
      ...baseDevice,
      currentState: '   ',
    })).toBe('unknown');
    expect(resolvePlanStateTone(baseDevice)).toBe('neutral');
  });

  it('uses idle as the default for enabled off devices', () => {
    expect(resolvePlanStateKind({
      ...baseDevice,
      currentState: 'off',
    })).toBe('idle');
  });

  // Prod 2026-08-01: a target-only thermostat (currentState 'not_applicable') at
  // 20.8 °C against a 16 °C target, drawing 0.0 kW, rendered "Running" — the only
  // card claiming activity was the one device with nothing to do. A satisfied
  // target-only device drawing nothing is Idle.
  describe('satisfied target-only devices', () => {
    const targetOnly = {
      ...baseDevice,
      currentState: 'not_applicable',
    };

    it('resolves idle when at/above target and drawing nothing', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        currentTemperature: 20.8,
        currentTarget: 16,
        measuredPowerKw: 0,
      })).toBe('idle');
    });

    it('treats a missing power measurement as not drawing (unmetered thermostat)', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        currentTemperature: 21.5,
        currentTarget: 21,
      })).toBe('idle');
    });

    it('stays active while below target (calling for heat)', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        currentTemperature: 18.4,
        currentTarget: 21,
        measuredPowerKw: 0,
      })).toBe('active');
    });

    it('stays active while drawing power even at target (still heating)', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        currentTemperature: 21.0,
        currentTarget: 21,
        measuredPowerKw: 0.8,
      })).toBe('active');
    });

    it('keeps the active inference when temperatures are unknown', () => {
      expect(resolvePlanStateKind(targetOnly)).toBe('active');
      expect(resolvePlanStateKind({
        ...targetOnly,
        currentTemperature: 'n/a',
        currentTarget: 21,
      })).toBe('active');
    });

    it('never outranks an explicit shed hold', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        plannedState: 'shed',
        currentTemperature: 22,
        currentTarget: 16,
        measuredPowerKw: 0,
      })).toBe('held');
    });

    // The mirror-image trap: `currentTarget` can be the setpoint PELS itself
    // lowered (keep-state restore windows carry the shed floor until the raise
    // lands). "Satisfied" against the lowered floor would read "Idle — nothing
    // to do" on a room PELS is actively suppressing.
    it('does not classify satisfaction against the PELS-lowered shed floor', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        shedAction: 'set_temperature',
        shedTemperature: 16,
        currentTemperature: 20.8,
        currentTarget: 16,
        measuredPowerKw: 0,
      })).toBe('active');
    });

    it('judges satisfaction against the planned target when it is higher than the live setpoint', () => {
      const base = {
        ...targetOnly,
        currentTarget: 16,
        plannedTarget: 21,
        measuredPowerKw: 0,
      };
      // Room above the lowered live setpoint but below the planned comfort
      // target: still work to do once the raise lands.
      expect(resolvePlanStateKind({ ...base, currentTemperature: 20.8 })).toBe('active');
      // Room above the planned target too: genuinely satisfied.
      expect(resolvePlanStateKind({ ...base, currentTemperature: 21.4 })).toBe('idle');
    });

    it('does not classify while a target command is in flight', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        currentTemperature: 21.5,
        currentTarget: 21,
        measuredPowerKw: 0,
        pendingTargetCommand: { targetC: 22 },
      })).toBe('active');
    });
  });

  it('keeps explicit restore-pending states resuming', () => {
    expect(resolvePlanStateKind({
      ...baseDevice,
      currentState: 'off',
      binaryCommandPending: true,
    })).toBe('resuming');
    expect(resolvePlanStateKind({
      ...baseDevice,
      controlModel: 'stepped_load',
      currentState: 'off',
      selectedStepId: 'eco',
      desiredStepId: 'comfort',
    })).toBe('resuming');
  });

  it('detects stepped restore-pending from the step ids alone (plan devices carry no controlModel)', () => {
    // Plan devices no longer carry `controlModel`; the distinct selected→desired
    // step pair only exists on a stepped device, so it must still read as resuming.
    expect(resolvePlanStateKind({
      ...baseDevice,
      currentState: 'off',
      selectedStepId: 'eco',
      desiredStepId: 'comfort',
    })).toBe('resuming');
    // A non-stepped off device (no step ids) is not resuming.
    expect(resolvePlanStateKind({ ...baseDevice, currentState: 'off' })).not.toBe('resuming');
  });
});
