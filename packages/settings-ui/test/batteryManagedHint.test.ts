let limitsInForce: boolean | null = null;
vi.mock('../src/ui/setupPathFacts.ts', () => ({ readSetupLimitsInForce: () => limitsInForce }));

const { resolveBatteryManagedHint } = await import('../src/ui/deviceDetail/batterySection.ts');

describe('battery Managed hint', () => {
  it('names the limit while one is in force, or while the limits are still being read', () => {
    limitsInForce = true;
    expect(resolveBatteryManagedHint())
      .toBe('PELS controls charging and discharging to store spare solar and hold your limit.');
    limitsInForce = null;
    expect(resolveBatteryManagedHint()).toContain('hold your limit');
  });

  it('names only the solar job with Power limits off: there is no limit to hold', () => {
    limitsInForce = false;
    expect(resolveBatteryManagedHint())
      .toBe('PELS controls charging to store spare solar in priority order.');
  });
});
