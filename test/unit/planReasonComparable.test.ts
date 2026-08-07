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
      availableKw: number;
      postReserveMarginKw: number;
      minimumRequiredPostReserveMarginKw: number;
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

    // Only the three genuinely-optional fields can be null: they describe
    // conditions that may not be in play (no activation penalty; no swap path).
    // The admission quartet is non-nullable on the reason type — every producer
    // computes all four — so there is no null to preserve there.
    it('preserves nulls on the genuinely-optional fields', () => {
      const comparable = buildComparableDeviceReason(baseReason({
        penaltyExtraKw: null,
        swapReserveKw: null,
        effectiveAvailableKw: null,
      }));
      expect(comparable).toMatchObject({
        penaltyExtraW: null,
        swapReserveW: null,
        effectiveAvailableW: null,
      });
    });
  });
  // The card renders a kW off a `dailyBudget` hold, but that number must NOT
  // reach any comparable. It tracks `softLimitKw − totalKw`, which drifts
  // continuously, and this signature gates the per-device device-log ring buffer
  // (`planOverviewEmit.ts`). Including it would fill a 50-entry recorder with
  // rows whose rendered `statusMsg` is identical — the logged text for a budget
  // hold carries no kW — and evict the real transitions.
  //
  // Same rule the repo already enforces for `shortfall` via CODE_ONLY_REASONS
  // ("ignores shortfall jitter in overview transition signatures",
  // test/unit/deviceOverview.test.ts).
  // The holder is display-only like `shortfallKw`, and IS folded in — the
  // exclusion below is earned by churn, not by the display-only label. A holder
  // changes only when the reserving device changes or its reservation lifts, so
  // it is a real transition; leaving it out let a card keep (or fail to start
  // showing) "Waiting so X can start" until something unrelated moved.
  describe('the reservation holder IS part of the comparable', () => {
    it('distinguishes a reserve-blocked hold from a plain one', () => {
      const blocked = buildComparableDeviceReason({
        code: PLAN_REASON_CODES.capacity, detail: null, reserveHolderName: 'Water heater',
      });
      const plain = buildComparableDeviceReason({ code: PLAN_REASON_CODES.capacity, detail: null });
      expect(blocked).not.toEqual(plain);
    });

    it('moves when the holder changes', () => {
      const first = buildComparableDeviceReason({
        code: PLAN_REASON_CODES.capacity, detail: null, reserveHolderName: 'Water heater',
      });
      const second = buildComparableDeviceReason({
        code: PLAN_REASON_CODES.capacity, detail: null, reserveHolderName: 'EV charger',
      });
      expect(first).not.toEqual(second);
    });

    it('folds into swap comparables too', () => {
      const blocked = buildComparableDeviceReason({
        code: PLAN_REASON_CODES.swappedOut, targetName: 'Heater', reserveHolderName: 'Water heater',
      });
      expect(blocked).toEqual({
        code: PLAN_REASON_CODES.swappedOut, targetName: 'Heater', reserveHolderName: 'Water heater',
      });
    });

    // Absent must stay byte-identical to the pre-existing shape, or shipping
    // this field would have flipped every signature once and flushed the rings.
    it('leaves the shape untouched when no reservation is involved', () => {
      expect(buildComparableDeviceReason({ code: PLAN_REASON_CODES.capacity, detail: null }))
        .toEqual({ code: PLAN_REASON_CODES.capacity, detail: null });
      expect(buildComparableDeviceReason({ code: PLAN_REASON_CODES.swappedOut, targetName: 'Heater' }))
        .toEqual({ code: PLAN_REASON_CODES.swappedOut, targetName: 'Heater' });
    });
  });

  describe('display-only shortfall stays out of the comparable', () => {
    it('compares a daily-budget hold on detail alone, whatever kW it carries', () => {
      const withGap = buildComparableDeviceReason({
        code: PLAN_REASON_CODES.dailyBudget, detail: null, shortfallKw: 0.8,
      });
      const withoutGap = buildComparableDeviceReason({
        code: PLAN_REASON_CODES.dailyBudget, detail: null,
      });
      expect(withGap).toEqual({ code: PLAN_REASON_CODES.dailyBudget, detail: null });
      expect(withGap).toEqual(withoutGap);
    });

    // The churn case the ring buffer actually sees: house power moves, the pace
    // moves, the displayed gap steps a whole 0.1 kW — and the signature must not.
    it('is unchanged when the displayed kW steps between cycles', () => {
      const cycleOne = buildComparableDeviceReason({
        code: PLAN_REASON_CODES.dailyBudget, detail: null, shortfallKw: 0.8,
      });
      const cycleTwo = buildComparableDeviceReason({
        code: PLAN_REASON_CODES.dailyBudget, detail: null, shortfallKw: 1.3,
      });
      expect(cycleOne).toEqual(cycleTwo);
    });

    it('compares a startup-reservation hold on the holder name alone', () => {
      expect(buildComparableDeviceReason({
        code: PLAN_REASON_CODES.reservedForStart,
        targetName: 'Water heater',
      })).toEqual({ code: PLAN_REASON_CODES.reservedForStart, targetName: 'Water heater' });
    });
  });
});
