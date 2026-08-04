import {
  resolveTemperatureLine,
  resolveTemperatureReasonLine,
} from '../../shared-domain/src/planTemperatureCardText.ts';
import {
  PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
  PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS,
  PLAN_STATE_HELD_FALLBACK_STATUS,
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

  // WHICH ceiling is binding is a house-level fact the hero states once, so the
  // card spends its one line on what THIS device needs. When the hold carries a
  // resolved shortfall the card names it; without one it says only that the
  // device is waiting.
  it('states the shortfall, not the ceiling, for a daily-budget hold', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'shed',
      currentTemperature: 20.2,
      plannedTarget: 21,
      reason: { code: 'daily_budget', detail: null, shortfallKw: 0.8 },
    })).toBe('Waiting to resume — 0.8 kW more needed');
  });

  it('falls back to the bare waiting line when a budget hold carries no shortfall', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'shed',
      currentTemperature: 20.2,
      plannedTarget: 21,
      reason: { code: 'daily_budget', detail: null },
    })).toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
  });

  // No card line may name a ceiling. Carriers with a shortfall state the kW
  // (`capacity` gets its number attached by `finalizeCeilingReason` when the
  // restore lane supplied none); a numberless carrier stays on the bare waiting
  // line; the exhausted hourly budget renders time-based copy — the one line
  // that legitimately mentions the word "budget", as a recourse rather than a
  // ceiling attribution.
  it('never attributes a ceiling on a card', () => {
    const lines = ([
      { code: 'capacity', detail: null },
      { code: 'capacity', detail: null, shortfallKw: 1.1 },
      { code: 'hourly_budget', detail: null },
      { code: 'daily_budget', detail: null },
      { code: 'daily_budget', detail: null, shortfallKw: 0.5 },
    ] as const).map((reason) => resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'shed',
      currentTemperature: 20.2,
      plannedTarget: 21,
      reason,
    }));

    expect(lines).toEqual([
      PLAN_STATE_HELD_FALLBACK_STATUS,
      'Waiting to resume — 1.1 kW more needed',
      "Waiting to resume — this hour's budget is spent",
      PLAN_STATE_HELD_FALLBACK_STATUS,
      'Waiting to resume — 0.5 kW more needed',
    ]);
    for (const line of lines) {
      expect(line).not.toMatch(/hard cap|limited by/i);
    }
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

  // A shed with no attributed reason: PELS knows it is holding the device but
  // not which gate is doing it. "Lowered by PELS" used to fill this slot —
  // restating the bold `Limited` state word and naming no cause. The bare
  // waiting line is the honest answer, and it needs no simulation variant
  // because "waiting" claims no action.
  it('says only that the device is waiting when no constraint is attributed', () => {
    const unattributed = {
      currentState: 'on',
      plannedState: 'shed' as const,
      currentTemperature: 22.8,
      plannedTarget: 20,
      reason: { code: 'none' as const },
    };
    expect(resolveTemperatureReasonLine(unattributed)).toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
    expect(resolveTemperatureReasonLine(unattributed, true)).toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
  });

  // A binary-commanded thermostat has no planned temperature, so it answers
  // before the temperature-evidence gate. It gets the same line as every other
  // held card — the old "Turned off by PELS" said less than the state word did.
  it('states the shortfall on a binary-commanded card without a planned target', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'on',
      plannedState: 'shed',
      currentTemperature: 20.3,
      currentTarget: 22,
      shedAction: 'turn_off',
      reason: { code: 'daily_budget', detail: null, shortfallKw: 1.2 },
    })).toBe('Waiting to resume — 1.2 kW more needed');
  });

  it('never claims PELS turned the device off', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'on',
      plannedState: 'shed',
      currentTemperature: 20.3,
      currentTarget: 22,
      shedAction: 'turn_off',
      reason: { code: 'capacity', detail: null },
    })).toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
  });
});
