import type { StarvationRescueDevicesPayload } from '../starvationRescueWidgetTypes';

// Device list shown ONLY in the `?preview=1` design-preview path (the dashboard
// widget gallery thumbnail and local previews). On a real boot the widget never
// substitutes these — a missing API client surfaces a "connecting" state, not
// canned data — so a user can never act on sample devices. One long-starved
// budget row (offers a rescue, danger tone) and one capacity row (informational
// only) so the gallery shows both the rescue affordance and the guardrail.
export const PREVIEW_STARVATION_RESCUE_DEVICES: StarvationRescueDevicesPayload = {
  state: 'ready',
  devices: [
    {
      deviceId: 'preview-hot-water',
      deviceName: 'Hot water',
      cause: 'budget',
      accumulatedMs: 42 * 60 * 1000,
      intendedNormalTargetC: 65,
    },
    {
      deviceId: 'preview-radiator',
      deviceName: 'Living room',
      cause: 'capacity',
      accumulatedMs: 11 * 60 * 1000,
      intendedNormalTargetC: 21,
    },
  ],
};
