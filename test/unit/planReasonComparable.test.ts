import {
  PLAN_REASON_CODES,
  buildComparableDeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics';

describe('buildComparableDeviceReason', () => {
  describe('restoreNeed kW quantization', () => {
    const baseReason = (overrides: { needKw?: number; headroomKw?: number | null } = {}) => ({
      code: PLAN_REASON_CODES.restoreNeed,
      fromTarget: 'low',
      toTarget: 'high',
      needKw: overrides.needKw ?? 1.234,
      headroomKw: overrides.headroomKw === undefined ? 0.8 : overrides.headroomKw,
    } as const);

    it('quantizes need and headroom into integer watts', () => {
      const comparable = buildComparableDeviceReason(baseReason());
      expect(comparable).toMatchObject({
        code: PLAN_REASON_CODES.restoreNeed,
        needW: 1200,
        headroomW: 800,
      });
    });

    it('treats sub-100 W jitter as the same comparable', () => {
      const a = buildComparableDeviceReason(baseReason({ needKw: 1.234, headroomKw: 0.812 }));
      const b = buildComparableDeviceReason(baseReason({ needKw: 1.241, headroomKw: 0.798 }));
      expect(a).toEqual(b);
    });

    it('keeps a >=100 W delta as a different comparable', () => {
      const a = buildComparableDeviceReason(baseReason({ needKw: 1.2 }));
      const b = buildComparableDeviceReason(baseReason({ needKw: 1.35 }));
      expect(a).not.toEqual(b);
    });

    it('preserves null headroom', () => {
      const comparable = buildComparableDeviceReason(baseReason({ headroomKw: null }));
      expect(comparable).toMatchObject({ headroomW: null });
    });
  });

  describe('insufficientHeadroom kW quantization', () => {
    const baseReason = (overrides: Partial<{
      needKw: number;
      availableKw: number | null;
      postReserveMarginKw: number | null;
      minimumRequiredPostReserveMarginKw: number | null;
      penaltyExtraKw: number | null;
      swapReserveKw: number | null;
      effectiveAvailableKw: number | null;
    }> = {}) => ({
      code: PLAN_REASON_CODES.insufficientHeadroom,
      needKw: overrides.needKw ?? 2.345,
      availableKw: overrides.availableKw === undefined ? 1.234 : overrides.availableKw,
      postReserveMarginKw: overrides.postReserveMarginKw === undefined ? 0.123 : overrides.postReserveMarginKw,
      minimumRequiredPostReserveMarginKw: overrides.minimumRequiredPostReserveMarginKw === undefined
        ? 0.5
        : overrides.minimumRequiredPostReserveMarginKw,
      penaltyExtraKw: overrides.penaltyExtraKw === undefined ? 0.05 : overrides.penaltyExtraKw,
      swapReserveKw: overrides.swapReserveKw === undefined ? 0.3 : overrides.swapReserveKw,
      effectiveAvailableKw: overrides.effectiveAvailableKw === undefined ? 1.5 : overrides.effectiveAvailableKw,
      swapTargetName: 'other',
    } as const);

    it('quantizes every kW field to integer watts at 100 W resolution', () => {
      const comparable = buildComparableDeviceReason(baseReason());
      expect(comparable).toMatchObject({
        code: PLAN_REASON_CODES.insufficientHeadroom,
        needW: 2300,
        availableW: 1200,
        postReserveMarginW: 100,
        minimumRequiredPostReserveMarginW: 500,
        penaltyExtraW: 100,
        swapReserveW: 300,
        effectiveAvailableW: 1500,
      });
    });

    it('treats sub-100 W jitter on any field as the same comparable', () => {
      const a = buildComparableDeviceReason(baseReason({ needKw: 2.341, availableKw: 1.234 }));
      const b = buildComparableDeviceReason(baseReason({ needKw: 2.348, availableKw: 1.241 }));
      expect(a).toEqual(b);
    });

    it('preserves nulls on optional fields', () => {
      const comparable = buildComparableDeviceReason(baseReason({
        availableKw: null,
        postReserveMarginKw: null,
        minimumRequiredPostReserveMarginKw: null,
        penaltyExtraKw: null,
        swapReserveKw: null,
        effectiveAvailableKw: null,
      }));
      expect(comparable).toMatchObject({
        availableW: null,
        postReserveMarginW: null,
        minimumRequiredPostReserveMarginW: null,
        penaltyExtraW: null,
        swapReserveW: null,
        effectiveAvailableW: null,
      });
    });
  });
});
