import {
  resolvePlanStateKind,
  resolvePlanStateTone,
} from '../../packages/shared-domain/src/planStateLabels';
import { fixtureDeviceReason } from '../utils/deviceReasonTestUtils';
import { steppedProfile } from '../utils/planTestUtils';

// No `steppedLoad` cluster and no `deviceType`: the default device is the plain
// binary one, and that absence is the whole marker.
const baseDevice = {
  reason: fixtureDeviceReason('keep')!,
  // The producer's own default rung (`DEFAULT_EXPECTED_POWER_KW`): its contract
  // promises a finite POSITIVE figure for every device, so a fixture default of
  // 0 would pin a value the producer never emits.
  expectedPowerKw: 1,
  controllable: true,
  available: true,
  plannedState: 'keep',
  // The producer resolves an unmetered device to 0 kW, so that is the base case
  // here too — `currentDrawKw` is required on `DeviceOverviewSnapshot` and there
  // is no "absent reading" a consumer could see.
  currentDrawKw: 0,
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
      deviceType: 'temperature' as const,
      currentState: 'not_applicable',
    };

    it('resolves idle when at/above target and drawing nothing', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        temperature: { currentTemperature: 20.8, currentTarget: 16, plannedTarget: 16 },
        currentDrawKw: 0,
      })).toBe('idle');
    });

    it('treats an unmetered thermostat (producer-resolved 0 kW) as not drawing', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        temperature: { currentTemperature: 21.5, currentTarget: 21, plannedTarget: 21 },
        currentDrawKw: 0,
      })).toBe('idle');
    });

    it('stays active while below target (calling for heat)', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        temperature: { currentTemperature: 18.4, currentTarget: 21, plannedTarget: 21 },
        currentDrawKw: 0,
      })).toBe('active');
    });

    it('stays active while drawing power even at target (still heating)', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        temperature: { currentTemperature: 21.0, currentTarget: 21, plannedTarget: 21 },
        currentDrawKw: 0.8,
      })).toBe('active');
    });

    it('keeps the active inference when the temperature facet is absent', () => {
      // A junk facet never reaches this resolver: the WebView adapter
      // (`parsePlanSnapshot`) drops an incomplete/non-finite facet wholly, so
      // "no facet" is the only unknown-temperature state left to model.
      expect(resolvePlanStateKind(targetOnly)).toBe('active');
    });

    it('never outranks an explicit shed hold', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        plannedState: 'shed',
        temperature: { currentTemperature: 22, currentTarget: 16, plannedTarget: 16 },
        currentDrawKw: 0,
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
        temperature: { currentTemperature: 20.8, currentTarget: 16, plannedTarget: 16 },
        currentDrawKw: 0,
      })).toBe('active');
    });

    it('judges satisfaction against the planned target when it is higher than the live setpoint', () => {
      const base = {
        ...targetOnly,
        currentDrawKw: 0,
      };
      // Room above the lowered live setpoint but below the planned comfort
      // target: still work to do once the raise lands.
      expect(resolvePlanStateKind({
        ...base,
        temperature: { currentTemperature: 20.8, currentTarget: 16, plannedTarget: 21 },
      })).toBe('active');
      // Room above the planned target too: genuinely satisfied.
      expect(resolvePlanStateKind({
        ...base,
        temperature: { currentTemperature: 21.4, currentTarget: 16, plannedTarget: 21 },
      })).toBe('idle');
    });

    it('does not classify while a target command is in flight', () => {
      expect(resolvePlanStateKind({
        ...targetOnly,
        temperature: { currentTemperature: 21.5, currentTarget: 21, plannedTarget: 21 },
        currentDrawKw: 0,
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
      steppedLoad: {
        profile: steppedProfile,
        reportedStepId: 'eco',
        targetStepId: 'comfort',
        commandPending: false,
      },
      currentState: 'off',
      selectedStepId: 'eco',
      desiredStepId: 'comfort',
    })).toBe('resuming');
  });

  it('detects stepped restore-pending from the step ids alone (plan devices carry no stepped cluster)', () => {
    // Plan devices carry no `steppedLoad` cluster; the distinct selected→desired
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
