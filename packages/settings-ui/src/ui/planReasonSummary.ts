import { formatDeviceReasonUserFacing } from '../../../shared-domain/src/planReasonSemantics.ts';
import type { DeviceReason } from '../../../shared-domain/src/planReasonSemanticsCore.ts';

// Single source of truth for user-facing reason text lives in shared-domain.
// Keep this thin wrapper so existing call sites continue to compile and so the
// settings UI uses the same vocabulary that runtime telemetry surfaces.
export const formatReasonSummary = (reason: DeviceReason): string => (
  formatDeviceReasonUserFacing(reason)
);
