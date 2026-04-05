import {
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
  canAdmitRestore,
  shouldLogRestoreAdmissionAtInfo,
} from '../lib/plan/planRestoreAdmission';

describe('planRestoreAdmission', () => {
  it('computes margin fields with a fixed 0.25kW admission reserve', () => {
    const result = buildRestoreAdmissionMetrics({ availableKw: 1.02, neededKw: 0.98 });
    expect(result.admissionReserveKw).toBeCloseTo(0.25, 6);
    expect(result.marginKw).toBeCloseTo(0.04, 6);
    expect(result.postReserveMarginKw).toBeCloseTo(-0.21, 6);
    expect(result.requiredKw).toBeCloseTo(1.23, 6);
  });

  it('accepts restores only when available headroom meets needed plus reserve', () => {
    expect(canAdmitRestore({ availableKw: 1.22, neededKw: 0.98 }).postReserveMarginKw).toBeCloseTo(-0.01, 6);
    expect(canAdmitRestore({ availableKw: 1.23, neededKw: 0.98 }).postReserveMarginKw).toBeCloseTo(0, 6);
    expect(canAdmitRestore({ availableKw: 1.4, neededKw: 0.98 }).postReserveMarginKw).toBeCloseTo(0.17, 6);
  });

  it('builds a canonical non-redundant set of log fields', () => {
    const result = buildRestoreAdmissionLogFields(buildRestoreAdmissionMetrics({
      availableKw: 1.02,
      neededKw: 0.98,
    }));
    expect(result.reserveKw).toBeCloseTo(0.25, 6);
    expect(result.marginKw).toBeCloseTo(0.04, 6);
    expect(result.postReserveMarginKw).toBeCloseTo(-0.21, 6);
  });

  it('logs ordinary restore admits at debug when they are not interesting', () => {
    expect(shouldLogRestoreAdmissionAtInfo({
      restoreType: 'binary',
      marginKw: 0.5,
      penaltyLevel: 0,
      powerSource: 'planning',
      recentInstabilityMs: null,
      nowTs: 1_000_000,
    })).toBe(false);
  });

  it('logs low-margin or risky restore admits at info', () => {
    expect(shouldLogRestoreAdmissionAtInfo({
      restoreType: 'binary',
      marginKw: 0.29,
      penaltyLevel: 0,
      powerSource: 'planning',
    })).toBe(true);
    expect(shouldLogRestoreAdmissionAtInfo({
      restoreType: 'binary',
      marginKw: 0.5,
      penaltyLevel: 1,
      powerSource: 'planning',
    })).toBe(true);
    expect(shouldLogRestoreAdmissionAtInfo({
      restoreType: 'binary',
      marginKw: 0.5,
      penaltyLevel: 0,
      powerSource: 'fallback',
    })).toBe(true);
    expect(shouldLogRestoreAdmissionAtInfo({
      restoreType: 'swap',
      marginKw: 0.5,
      penaltyLevel: 0,
      powerSource: 'planning',
    })).toBe(true);
  });

  it('keeps the thin-margin threshold boundary explicit', () => {
    expect(shouldLogRestoreAdmissionAtInfo({
      restoreType: 'binary',
      marginKw: 0.3,
      penaltyLevel: 0,
      powerSource: 'planning',
      recentInstabilityMs: null,
      nowTs: 1_000_000,
    })).toBe(false);
  });
});
