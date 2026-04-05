import {
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
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
    expect(buildRestoreAdmissionMetrics({ availableKw: 1.22, neededKw: 0.98 }).postReserveMarginKw).toBeCloseTo(-0.01, 6);
    expect(buildRestoreAdmissionMetrics({ availableKw: 1.23, neededKw: 0.98 }).postReserveMarginKw).toBeCloseTo(0, 6);
    expect(buildRestoreAdmissionMetrics({ availableKw: 1.4, neededKw: 0.98 }).postReserveMarginKw).toBeCloseTo(0.17, 6);
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
});
