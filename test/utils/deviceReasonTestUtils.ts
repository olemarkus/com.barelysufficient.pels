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
// `marginKw = availableKw − needKw`, and admission passes at `marginKw >= 0`.
// Inlined rather than imported so the fixtures stay stable if the planner
// retunes — a fixture asserts a shape, not a live constant.
export const insufficientHeadroomFixtureReason = (params: {
  needKw: number;
  availableKw: number;
}): DeviceReason => ({
  code: PLAN_REASON_CODES.insufficientHeadroom,
  needKw: params.needKw,
  availableKw: params.availableKw,
  marginKw: Number((params.availableKw - params.needKw).toFixed(3)),
  penaltyExtraKw: null,
  swapReserveKw: null,
  effectiveAvailableKw: null,
});

export const reasonText = (reason: DeviceReason | string | undefined): string => {
  if (typeof reason === 'string') return reason;
  return reason ? formatDeviceReason(reason) : '';
};
