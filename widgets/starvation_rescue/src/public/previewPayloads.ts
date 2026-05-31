import type { StarvationRescueDevicesPayload } from '../starvationRescueWidgetTypes';

// Device list shown ONLY in the `?preview=1` design-preview path (the dashboard
// widget gallery thumbnail and local previews). On a real boot the widget never
// substitutes these — a missing API client surfaces a "connecting" state, not
// canned data — so a user can never act on sample devices. A long-starved budget
// row (offers a rescue, danger tone), a capacity row (informational only), and a
// budget row whose device already has a smart task (shown but button-suppressed)
// so the gallery shows the rescue affordance AND both no-rescue states.
export const PREVIEW_STARVATION_RESCUE_DEVICES: StarvationRescueDevicesPayload = {
  state: 'ready',
  devices: [
    {
      deviceId: 'preview-hot-water',
      deviceName: 'Hot water',
      cause: 'budget',
      accumulatedMs: 42 * 60 * 1000,
      intendedNormalTargetC: 65,
      hasSmartTask: false,
    },
    {
      deviceId: 'preview-radiator',
      deviceName: 'Living room',
      cause: 'capacity',
      accumulatedMs: 11 * 60 * 1000,
      intendedNormalTargetC: 21,
      hasSmartTask: false,
    },
    {
      deviceId: 'preview-floor',
      deviceName: 'Bathroom floor',
      cause: 'budget',
      accumulatedMs: 18 * 60 * 1000,
      intendedNormalTargetC: 24,
      hasSmartTask: true,
    },
  ],
};
