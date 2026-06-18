import { resolveEffectiveMinRunMinutes } from '../../lib/utils/minRunResolution';

describe('resolveEffectiveMinRunMinutes', () => {
  it('returns undefined (legacy grace) when the toggle is off and there is no override', () => {
    expect(resolveEffectiveMinRunMinutes({
      deviceOverride: undefined,
      energyBudgetAdmissionEnabled: false,
      defaultMinRunMinutes: 15,
    })).toBeUndefined();
  });

  it('applies the global default when the toggle is on and there is no override', () => {
    expect(resolveEffectiveMinRunMinutes({
      deviceOverride: undefined,
      energyBudgetAdmissionEnabled: true,
      defaultMinRunMinutes: 15,
    })).toBe(15);
  });

  it('returns undefined when the toggle is on but no default is set', () => {
    expect(resolveEffectiveMinRunMinutes({
      deviceOverride: undefined,
      energyBudgetAdmissionEnabled: true,
      defaultMinRunMinutes: undefined,
    })).toBeUndefined();
  });

  it('lets an explicit per-device override win over the default while the toggle is on', () => {
    expect(resolveEffectiveMinRunMinutes({
      deviceOverride: 30,
      energyBudgetAdmissionEnabled: true,
      defaultMinRunMinutes: 15,
    })).toBe(30);
  });

  it('lets an explicit per-device override win even when the toggle is off', () => {
    expect(resolveEffectiveMinRunMinutes({
      deviceOverride: 30,
      energyBudgetAdmissionEnabled: false,
      defaultMinRunMinutes: 15,
    })).toBe(30);
  });

  it('treats an explicit 0 override as a per-device opt-out (legacy grace), not "fall through to default"', () => {
    expect(resolveEffectiveMinRunMinutes({
      deviceOverride: 0,
      energyBudgetAdmissionEnabled: true,
      defaultMinRunMinutes: 15,
    })).toBe(0);
  });
});
