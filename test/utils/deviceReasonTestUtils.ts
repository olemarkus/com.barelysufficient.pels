import {
  PLAN_REASON_CODES,
  formatDeviceReason,
  type DeviceReason,
} from '../../packages/shared-domain/src/planReasonSemantics.ts';
import { buildFixturePlanReason } from './planReasonFixtureParser.ts';

export const fixtureDeviceReason = (reason: string | undefined): DeviceReason | undefined => (
  typeof reason === 'string' ? buildFixturePlanReason(reason) : undefined
);

// `insufficient_headroom` has no prose fixture form — see the header of
// `planReasonFixtureParser.ts`. Its admission figures follow
// `buildRestoreAdmissionMetrics` (`lib/plan/admission/reserve.ts`):
// `postReserveMarginKw = availableKw − needKw − RESTORE_ADMISSION_RESERVE_KW`,
// and admission passes at `RESTORE_ADMISSION_FLOOR_KW`. Both constants are 0.25,
// and both are inlined here rather than imported so a fixture never moves when
// the planner retunes them — a fixture asserts a shape, not a live constant.
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

export const reasonText = (reason: DeviceReason | string | undefined): string => {
  if (typeof reason === 'string') return reason;
  return reason ? formatDeviceReason(reason) : '';
};
