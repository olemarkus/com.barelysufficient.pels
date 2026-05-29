import type { CreateSmartTaskDevicesPayload } from '../createSmartTaskWidgetTypes';

// Device list shown ONLY in the `?preview=1` design-preview path (the dashboard
// widget gallery thumbnail and local previews). On a real boot the widget never
// substitutes these — a missing API client surfaces a "connecting" state, not
// canned data — so a user can never act on sample devices. One temperature
// device and one EV charger so the gallery shows both goal kinds.
export const PREVIEW_CREATE_SMART_TASK_DEVICES: CreateSmartTaskDevicesPayload = {
  state: 'ready',
  devices: [
    {
      deviceId: 'preview-hot-water',
      deviceName: 'Hot water',
      kind: 'temperature',
      unitSymbol: '°C',
      goalMin: 5,
      goalMax: 85,
      goalStep: 0.5,
      defaultGoal: 65,
      currentValue: 48,
    },
    {
      deviceId: 'preview-ev',
      deviceName: 'Driveway charger',
      kind: 'ev_soc',
      unitSymbol: '%',
      goalMin: 1,
      goalMax: 100,
      goalStep: 1,
      defaultGoal: 80,
      currentValue: 42,
    },
  ],
};
