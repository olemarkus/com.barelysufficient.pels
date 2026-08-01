import {
  resolveTemperatureLine,
  resolveTemperatureReasonLine,
} from '../../shared-domain/src/planTemperatureCardText.ts';
import {
  PLAN_STATE_DAILY_BUDGET_STATUS,
  PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
  PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS,
} from '../../shared-domain/src/planStateLabels.ts';

describe('resolveTemperatureLine', () => {
  it('shows the planned target when the target is stable', () => {
    expect(resolveTemperatureLine({
      currentTemperature: 20.2,
      currentTarget: 21,
      plannedTarget: 21,
      reason: { code: 'none' },
    })).toBe('20.2 °C · target 21 °C');
  });

  it('shows the current target to planned target transition when PELS is changing it', () => {
    expect(resolveTemperatureLine({
      currentTemperature: 20.2,
      currentTarget: 18,
      plannedTarget: 21,
      reason: { code: 'none' },
    })).toBe('20.2 °C · target 18 °C → 21 °C');
  });

  it('reports sensor offline when the planned target is known but currentTemperature is missing', () => {
    expect(resolveTemperatureLine({
      currentTarget: 21,
      plannedTarget: 21,
      reason: { code: 'none' },
    })).toBe('target 21 °C · sensor unavailable');
  });

  it('shows the external target when PELS has no planned temperature', () => {
    expect(resolveTemperatureLine({
      currentTemperature: 20.3,
      currentTarget: 22,
      reason: { code: 'none' },
    })).toBe('20.3 °C · target 22 °C');
  });

  it('reports the sensor unavailable when only the external target is known', () => {
    expect(resolveTemperatureLine({
      currentTarget: 22,
      reason: { code: 'none' },
    })).toBe('target 22 °C · sensor unavailable');
  });

  it('does not format non-finite temperature observations or targets', () => {
    expect(resolveTemperatureLine({
      currentTemperature: Number.NaN,
      currentTarget: 22,
      plannedTarget: undefined,
      reason: { code: 'none' },
    })).toBe('target 22 °C · sensor unavailable');
    expect(resolveTemperatureLine({
      currentTemperature: 20,
      currentTarget: Number.POSITIVE_INFINITY,
      plannedTarget: Number.NaN,
      reason: { code: 'none' },
    })).toBeNull();
  });
});

describe('resolveTemperatureReasonLine', () => {
  it('shows the concrete power gap when waiting to resume', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'shed',
      currentTemperature: 20.2,
      plannedTarget: 21,
      reason: {
        code: 'insufficient_headroom',
        needKw: 1.25,
        availableKw: 0.45,
        effectiveAvailableKw: 0.45,
        postReserveMarginKw: null,
        minimumRequiredPostReserveMarginKw: null,
        penaltyExtraKw: null,
        swapReserveKw: null,
        swapTargetName: null,
      },
    })).toBe('Waiting to resume — 0.8 kW more needed');
  });

  // Production-shaped reason (margins present): the gap is the admission-accurate
  // shortfall `minimumRequired − postReserveMargin`, not `need − available`.
  it('shows the admission-accurate gap when reserve margins are present', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'shed',
      currentTemperature: 20.2,
      plannedTarget: 21,
      reason: {
        code: 'insufficient_headroom',
        needKw: 1.25,
        availableKw: 0.45,
        effectiveAvailableKw: null,
        postReserveMarginKw: -1.05,
        minimumRequiredPostReserveMarginKw: 0.25,
        penaltyExtraKw: null,
        swapReserveKw: null,
        swapTargetName: null,
      },
    })).toBe('Waiting to resume — 1.3 kW more needed');
  });

  it('does not show idle as a reason line', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'inactive',
      currentTemperature: 20.2,
      plannedTarget: 21,
      reason: { code: 'none' },
    })).toBeNull();
  });

  it('explains an external off hold even when temperature evidence is unavailable', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'inactive',
      reason: { code: 'external_off_hold' },
    })).toBe(PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS);
  });

  it('suppresses stale external-off guidance when the device is unavailable', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'inactive',
      stateKind: 'unavailable',
      reason: { code: 'external_off_hold' },
    })).toBeNull();
  });

  it('uses plain budget wording for daily-budget limiting', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'shed',
      currentTemperature: 20.2,
      plannedTarget: 21,
      reason: { code: 'daily_budget', detail: null },
    })).toBe(PLAN_STATE_DAILY_BUDGET_STATUS);
  });

  it('renders the deferred-objective avoid status for smart-task waiting', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'shed',
      currentTemperature: 20.2,
      plannedTarget: 21,
      reason: { code: 'deferred_objective_avoid', detail: null },
    })).toBe(PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS);
  });

  it('states "Lowered by PELS" as fact when not simulating', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'on',
      plannedState: 'shed',
      currentTemperature: 22.8,
      plannedTarget: 20,
      reason: { code: 'none' },
    })).toBe('Lowered by PELS');
  });

  it('states the held action hypothetically in simulation mode (dryRun)', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'on',
      plannedState: 'shed',
      currentTemperature: 22.8,
      plannedTarget: 20,
      reason: { code: 'none' },
    }, true)).toBe('Would be lowered (simulation)');
  });

  it('states the binary action on an observational temperature card without a planned target', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'on',
      plannedState: 'shed',
      currentTemperature: 20.3,
      currentTarget: 22,
      shedAction: 'turn_off',
      reason: { code: 'capacity', detail: null },
    })).toBe('Turned off by PELS');
  });

  const heldThermostat = (code: 'capacity' | 'hourly_budget' | 'daily_budget') => ({
    currentState: 'on',
    plannedState: 'shed' as const,
    currentTemperature: 22.8,
    plannedTarget: 20,
    reason: { code, detail: null },
  });

  it('states capacity / hourly / daily limiting as FACT when not simulating', () => {
    expect(resolveTemperatureReasonLine(heldThermostat('capacity'))).toBe('Limited by the hard cap');
    expect(resolveTemperatureReasonLine(heldThermostat('hourly_budget'))).toBe('Limited — this hour is near the hard cap');
    expect(resolveTemperatureReasonLine(heldThermostat('daily_budget'))).toBe("Limited by today's daily budget");
  });

  it('states capacity / hourly / daily limiting HYPOTHETICALLY in simulation (dryRun)', () => {
    expect(resolveTemperatureReasonLine(heldThermostat('capacity'), true)).toBe('Would be limited by the hard cap (simulation)');
    expect(resolveTemperatureReasonLine(heldThermostat('hourly_budget'), true)).toBe('Would be limited — this hour is near the hard cap (simulation)');
    expect(resolveTemperatureReasonLine(heldThermostat('daily_budget'), true)).toBe("Would be limited by today's daily budget (simulation)");
  });
});
