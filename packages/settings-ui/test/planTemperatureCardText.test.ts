import {
  resolveTemperatureLine,
  resolveTemperatureReasonLine,
} from '../../shared-domain/src/planTemperatureCardText.ts';

describe('resolveTemperatureLine', () => {
  it('shows the planned target when the target is stable', () => {
    expect(resolveTemperatureLine({
      currentTemperature: 20.2,
      currentTarget: 21,
      plannedTarget: 21,
      reason: { code: 'none' },
    })).toBe('20.2° · target 21°');
  });

  it('shows the current target to planned target transition when PELS is changing it', () => {
    expect(resolveTemperatureLine({
      currentTemperature: 20.2,
      currentTarget: 18,
      plannedTarget: 21,
      reason: { code: 'none' },
    })).toBe('20.2° · target 18° → 21°');
  });

  it('reports sensor offline when the planned target is known but currentTemperature is missing', () => {
    expect(resolveTemperatureLine({
      currentTarget: 21,
      plannedTarget: 21,
      reason: { code: 'none' },
    })).toBe('target 21° · sensor unavailable');
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

  it('does not show idle as a reason line', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'inactive',
      currentTemperature: 20.2,
      plannedTarget: 21,
      reason: { code: 'none' },
    })).toBeNull();
  });

  it('uses plain budget wording for daily-budget limiting', () => {
    expect(resolveTemperatureReasonLine({
      currentState: 'off',
      plannedState: 'shed',
      currentTemperature: 20.2,
      plannedTarget: 21,
      reason: { code: 'daily_budget', detail: null },
    })).toBe("Limited — staying within today's budget");
  });
});
