import type {
  DeferredObjectivePlanPreviewEstimate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type { StarvationRescueRejectReason } from '../../../packages/contracts/src/starvationRescue';

// Re-export the browser-safe payload so the widget's render/controller import
// from one place. The payload is produced by the runtime backend
// (`App.getStarvedRescueDevices`) and shaped by `buildStarvationRescueDevicesPayload`.
// The reject vocabulary and the create response are the settings UI's: both
// surfaces post the same rescue.
export type {
  SettingsUiStarvationRescueCreateResponse as StarvationRescueCreateResponse,
  StarvationRescueDevice,
  StarvationRescueDevicesPayload,
  StarvationRescueRejectReason,
} from '../../../packages/contracts/src/starvationRescue';
// The rescue request the widget POSTs (`parseRescueRequest` reads it server-side).
export type { StarvationRescueRequest } from '../../../packages/shared-domain/src/starvationRescueShared';

// Preview response: the priority-coordinated plan estimate plus the resolved
// near-term deadline and a pre-formatted local label (server-side, app timezone).
export type StarvationRescuePreviewResponse = {
  ok: true;
  deadlineAtMs: number;
  deadlineLabel: string;
  // The scheduled clock-hour window ("02:00–04:00"), formatted server-side in
  // the Homey timezone. Null when no hours are scheduled.
  scheduledWindowLabel: string | null;
  estimate: DeferredObjectivePlanPreviewEstimate;
} | {
  ok: false;
  reason: StarvationRescueRejectReason;
};
