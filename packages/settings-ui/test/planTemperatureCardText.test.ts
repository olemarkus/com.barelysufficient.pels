import {
  resolveTemperatureLine,
  resolveTemperatureReasonLine,
} from '../../shared-domain/src/planTemperatureCardText.ts';
import {
  PLAN_STATE_DEFERRED_OBJECTIVE_AVOID_STATUS,
  PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS,
  PLAN_STATE_HELD_FALLBACK_STATUS,
} from '../../shared-domain/src/planStateLabels.ts';

// The producer-resolved fields every `DeviceOverviewSnapshot` carries. These
// cards are temperature cards, so the control model is `temperature_target`;
// `currentDrawKw`/`expectedPowerKw` resolve to 0 for an unmetered device, and a
// managed, reachable device is what these tests are about.
const baseDevice = {
  controlModel: 'temperature_target' as const,
  currentDrawKw: 0,
  // The producer's own default rung (`DEFAULT_EXPECTED_POWER_KW`): its contract
  // promises a finite POSITIVE figure for every device, so a fixture default of
  // 0 would pin a value the producer never emits.
  expectedPowerKw: 1,
  controllable: true,
  available: true,
};

describe('resolveTemperatureLine', () => {
  it('shows the planned target when the target is stable', () => {
    expect(resolveTemperatureLine({
      ...baseDevice,
      temperature: { currentTemperature: 20.2, currentTarget: 21, plannedTarget: 21 },
      reason: { code: 'keep', detail: null },
    })).toBe('20.2 °C · target 21 °C');
  });

  it('shows the current target to planned target transition when PELS is changing it', () => {
    expect(resolveTemperatureLine({
      ...baseDevice,
      temperature: { currentTemperature: 20.2, currentTarget: 18, plannedTarget: 21 },
      reason: { code: 'keep', detail: null },
    })).toBe('20.2 °C · target 18 °C → 21 °C');
  });

  it('renders nothing without the temperature facet — the adapter drops a junk facet wholly', () => {
    // Partial or non-finite trios never reach this resolver: `parsePlanSnapshot`
    // validates the facet once at the WebView boundary and strips it, so the
    // card renders as a non-temperature card instead of inventing copy
    // (the old "sensor unavailable" line is retired with the partial state).
    expect(resolveTemperatureLine({
      ...baseDevice,
      reason: { code: 'keep', detail: null },
    })).toBeNull();
  });
});

describe('resolveTemperatureReasonLine', () => {
  // The gap is the admission-accurate shortfall
  // `minimumRequired − postReserveMargin`, never `need − available` — the latter
  // understates by the reserve stack (prod 2026-08-01). A reason with no margins
  // is not a shape any producer can emit, so there is nothing else to test here.
  it('shows the admission-accurate gap when reserve margins are present', () => {
    expect(resolveTemperatureReasonLine({
      ...baseDevice,
      currentState: 'off',
      plannedState: 'shed',
      temperature: { currentTemperature: 20.2, currentTarget: 21, plannedTarget: 21 },
      reason: {
        code: 'insufficient_headroom',
        needKw: 1.25,
        availableKw: 0.45,
        effectiveAvailableKw: null,
        postReserveMarginKw: -1.05,
        minimumRequiredPostReserveMarginKw: 0.25,
        penaltyExtraKw: null,
        swapReserveKw: null,
      },
    })).toBe('Waiting to resume — 1.3 kW more needed');
  });

  it('does not show idle as a reason line', () => {
    expect(resolveTemperatureReasonLine({
      ...baseDevice,
      currentState: 'off',
      plannedState: 'inactive',
      temperature: { currentTemperature: 20.2, currentTarget: 21, plannedTarget: 21 },
      reason: { code: 'keep', detail: null },
    })).toBeNull();
  });

  it('explains an external off hold even when temperature evidence is unavailable', () => {
    expect(resolveTemperatureReasonLine({
      ...baseDevice,
      currentState: 'off',
      plannedState: 'inactive',
      reason: { code: 'external_off_hold' },
    })).toBe(PLAN_STATE_EXTERNAL_OFF_HOLD_STATUS);
  });

  it('suppresses stale external-off guidance when the device is unavailable', () => {
    expect(resolveTemperatureReasonLine({
      ...baseDevice,
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
      ...baseDevice,
      currentState: 'off',
      plannedState: 'shed',
      temperature: { currentTemperature: 20.2, currentTarget: 21, plannedTarget: 21 },
      reason: { code: 'daily_budget', shortfallKw: 0.8 },
    })).toBe('Waiting to resume — 0.8 kW more needed');
  });

  it('falls back to the bare waiting line when a budget hold carries no shortfall', () => {
    expect(resolveTemperatureReasonLine({
      ...baseDevice,
      currentState: 'off',
      plannedState: 'shed',
      temperature: { currentTemperature: 20.2, currentTarget: 21, plannedTarget: 21 },
      reason: { code: 'daily_budget' },
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
      { code: 'capacity' },
      { code: 'capacity', shortfallKw: 1.1 },
      { code: 'hourly_budget' },
      { code: 'daily_budget' },
      { code: 'daily_budget', shortfallKw: 0.5 },
    ] as const).map((reason) => resolveTemperatureReasonLine({
      ...baseDevice,
      currentState: 'off',
      plannedState: 'shed',
      temperature: { currentTemperature: 20.2, currentTarget: 21, plannedTarget: 21 },
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
      ...baseDevice,
      currentState: 'off',
      plannedState: 'shed',
      temperature: { currentTemperature: 20.2, currentTarget: 21, plannedTarget: 21 },
      reason: { code: 'deferred_objective_avoid' },
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
      temperature: { currentTemperature: 22.8, currentTarget: 20, plannedTarget: 20 },
      ...baseDevice,
      reason: { code: 'keep' as const, detail: null },
    };
    expect(resolveTemperatureReasonLine(unattributed)).toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
    expect(resolveTemperatureReasonLine(unattributed, true)).toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
  });

  // A binary-commanded thermostat has no planned temperature, so it answers
  // before the temperature-evidence gate. It gets the same line as every other
  // held card — the old "Turned off by PELS" said less than the state word did.
  it('states the shortfall on a binary-commanded card without a planned target', () => {
    expect(resolveTemperatureReasonLine({
      ...baseDevice,
      currentState: 'on',
      plannedState: 'shed',
      temperature: { currentTemperature: 20.3, currentTarget: 22, plannedTarget: 22 },
      shedAction: 'turn_off',
      reason: { code: 'daily_budget', shortfallKw: 1.2 },
    })).toBe('Waiting to resume — 1.2 kW more needed');
  });

  it('never claims PELS turned the device off', () => {
    expect(resolveTemperatureReasonLine({
      ...baseDevice,
      currentState: 'on',
      plannedState: 'shed',
      temperature: { currentTemperature: 20.3, currentTarget: 22, plannedTarget: 22 },
      shedAction: 'turn_off',
      reason: { code: 'capacity' },
    })).toBe(PLAN_STATE_HELD_FALLBACK_STATUS);
  });
});
