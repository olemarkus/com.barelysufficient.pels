import {
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
  isRestoreAdmitted,
} from '../../lib/plan/admission';

describe('admission/reserve', () => {
  it('reports the power left over once the device is put back', () => {
    expect(buildRestoreAdmissionMetrics({ availableKw: 1.02, neededKw: 0.98 }).marginKw)
      .toBeCloseTo(0.04, 6);
    expect(buildRestoreAdmissionMetrics({ availableKw: 0.9, neededKw: 0.98 }).marginKw)
      .toBeCloseTo(-0.08, 6);
  });

  it('admits a device that fits in the room available to it, and nothing less', () => {
    // The bar is the device's own inflated need, with nothing withheld on top.
    // It used to be need + 0.25 reserve + 0.25 floor: two flat constants that
    // charged every restore of every device for the possibility that some other
    // restore might overshoot. Overshoot is now answered by the per-device
    // buffer, the recent-shed inflation and the activation-penalty ladder, all
    // of which scale to the device or to its own measured behaviour.
    expect(isRestoreAdmitted(buildRestoreAdmissionMetrics({ availableKw: 0.97, neededKw: 0.98 }))).toBe(false);
    expect(isRestoreAdmitted(buildRestoreAdmissionMetrics({ availableKw: 0.98, neededKw: 0.98 }))).toBe(true);
    expect(isRestoreAdmitted(buildRestoreAdmissionMetrics({ availableKw: 1.4, neededKw: 0.98 }))).toBe(true);
  });

  it('logs the one figure the decision was made on', () => {
    const fields = buildRestoreAdmissionLogFields(
      buildRestoreAdmissionMetrics({ availableKw: 1.02, neededKw: 0.98 }),
    );
    expect(fields).toEqual({ marginKw: expect.closeTo(0.04, 6) });
  });
});
