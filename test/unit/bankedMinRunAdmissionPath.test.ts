import type { DevicePlanDevice } from '../../lib/plan/planTypes';
import {
  resolveBinaryAdmissionPath,
  type BankedAdmissionContext,
} from '../../lib/plan/restore/bankedMinRunAdmission';

// `resolveBinaryAdmissionPath` reads only `admission.postReserveMarginKw`,
// `dev.minRunMinutes`, `restoreNeed.devPower`, and the flat `BankedAdmissionContext`,
// so minimal structural stand-ins are sufficient for this focused unit test.
const admissionMetrics = (postReserveMarginKw: number) => ({
  admissionReserveKw: 0.25,
  marginKw: postReserveMarginKw + 0.25,
  postReserveMarginKw,
  requiredKw: 3,
});
const LEGACY_PASS = admissionMetrics(0.3); // >= RESTORE_ADMISSION_FLOOR_KW (0.25)
const LEGACY_FAIL = admissionMetrics(0); //  <  floor → soft rail rejects

const restoreNeed = { needed: 3, devPower: 2.5, penaltyLevel: 0, penaltyExtraKw: 0 };
const dev = { minRunMinutes: 20 } as unknown as DevicePlanDevice;
const devNoMinRun = { minRunMinutes: 0 } as unknown as DevicePlanDevice;

// banked-eligible: used 1 + 2.5·(20/60)=1.833 ≤ 5 budget; total 1.5 + 2.5 = 4 ≤ 6 hard-cap rate.
const bankedEligible: BankedAdmissionContext = {
  powerKnown: true,
  usedThisHourKWh: 1,
  budgetKWh: 5,
  currentTotalPowerKw: 1.5,
  hardCapBurstRateKw: 6,
};

describe('resolveBinaryAdmissionPath — banked min-run gate', () => {
  it('takes the legacy instantaneous path when the soft-rail margin clears the floor, regardless of cycle position', () => {
    expect(
      resolveBinaryAdmissionPath({
        admission: LEGACY_PASS,
        dev,
        restoreNeed,
        bankedAdmission: bankedEligible,
        firstRestoreOfCycle: false,
      }),
    ).toBe('instantaneous');
  });

  it('admits via the banked path when the legacy gate fails and this is the first restore of the cycle', () => {
    expect(
      resolveBinaryAdmissionPath({
        admission: LEGACY_FAIL,
        dev,
        restoreNeed,
        bankedAdmission: bankedEligible,
        firstRestoreOfCycle: true,
      }),
    ).toBe('banked_min_run');
  });

  it('does NOT banked-admit a second device in the same cycle — the snapshot would be stale (hard-cap safety)', () => {
    expect(
      resolveBinaryAdmissionPath({
        admission: LEGACY_FAIL,
        dev,
        restoreNeed,
        bankedAdmission: bankedEligible,
        firstRestoreOfCycle: false,
      }),
    ).toBeNull();
  });

  it('does not banked-admit a device without a positive minimum run time', () => {
    expect(
      resolveBinaryAdmissionPath({
        admission: LEGACY_FAIL,
        dev: devNoMinRun,
        restoreNeed,
        bankedAdmission: bankedEligible,
        firstRestoreOfCycle: true,
      }),
    ).toBeNull();
  });
});
