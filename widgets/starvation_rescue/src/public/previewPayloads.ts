import type { StarvationRescueDevicesPayload } from '../starvationRescueWidgetTypes';

// Device list shown ONLY in the `?preview=1` design-preview path (the dashboard
// widget gallery thumbnail and local previews). On a real boot the widget never
// substitutes these — a missing API client surfaces a "connecting" state, not
// canned data — so a user can never act on sample devices. A long-held row
// (danger tone), a shorter-held row (warn tone), and a row whose device already
// has a smart task (shown but button-suppressed), so the gallery shows the
// rescue affordance, both tones, and the one remaining no-rescue state.
export const PREVIEW_STARVATION_RESCUE_DEVICES: StarvationRescueDevicesPayload = {
  state: 'ready',
  devices: [
    {
      deviceId: 'preview-hot-water',
      deviceName: 'Hot water',
      accumulatedMs: 42 * 60 * 1000,
      intendedNormalTargetC: 65,
      smartTaskHomeScope: 'main',
      hasSmartTask: false,
    },
    {
      deviceId: 'preview-radiator',
      deviceName: 'Living room',
      accumulatedMs: 11 * 60 * 1000,
      intendedNormalTargetC: 21,
      smartTaskHomeScope: 'main',
      hasSmartTask: false,
    },
    {
      deviceId: 'preview-floor',
      deviceName: 'Bathroom floor',
      accumulatedMs: 18 * 60 * 1000,
      intendedNormalTargetC: 24,
      smartTaskHomeScope: 'main',
      hasSmartTask: true,
    },
  ],
};
