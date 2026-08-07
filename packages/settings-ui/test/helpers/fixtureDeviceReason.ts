import { PLAN_REASON_CODES } from '../../../shared-domain/src/planReasonSemantics.ts';
import type { DeviceReason } from '../../../shared-domain/src/planReasonSemantics.ts';
import { buildFixturePlanReason } from '../../../../test/utils/planReasonFixtureParser.ts';

// Settings-UI entry point to the shared fixture-prose grammar. Both test trees
// are the same architectural layer (test code), so this imports the runtime
// tree's parser rather than duplicating 200 lines of regex that would drift.
//
// The grammar moved out of `packages/shared-domain/src/planReasonParsing.ts`
// on 2026-08-07; see that file's replacement header for why. The short version:
// it shipped in production, and its half-populated output forced
// `insufficient_headroom`'s admission fields to be nullable in the production
// reason type.
export const fixtureDeviceReason = (reason: string | undefined): DeviceReason => (
  buildFixturePlanReason(reason)
);

// `insufficient_headroom` has no prose form — its text does not fully specify
// the object. Mirrors `insufficientHeadroomFixtureReason` in
// `test/utils/deviceReasonTestUtils.ts`; admission figures follow
// `buildRestoreAdmissionMetrics` (`lib/plan/admission/reserve.ts`).
export const insufficientHeadroomFixtureReason = (params: {
  needKw: number;
  availableKw: number;
}): DeviceReason => ({
  code: PLAN_REASON_CODES.insufficientHeadroom,
  needKw: params.needKw,
  availableKw: params.availableKw,
  postReserveMarginKw: Number((params.availableKw - params.needKw - 0.25).toFixed(3)),
  minimumRequiredPostReserveMarginKw: 0.25,
  penaltyExtraKw: null,
  swapReserveKw: null,
  effectiveAvailableKw: null,
});
