import type { CreateSmartTaskDevicesPayload } from '../createSmartTaskWidgetTypes';

// Device lists shown ONLY in the `?preview=1` design-preview path (the dashboard
// widget gallery thumbnail and local previews). On a real boot the widget never
// substitutes these — a missing API client surfaces a "connecting" state, not
// canned data — so a user can never act on sample devices.
//
// Selected by `?state=<key>` in preview; defaults to the lean gallery thumbnail.
// The `overflow` state exists so the offline screenshot harness can exercise a
// device list longer than the widget's fixed height — the "list looks cut, no
// scroll" case the two-device default never renders.
//
// `supportsLimitLowerPriority` follows the gate-on-effect rule: true only for a
// stepped-load device at top priority. The EV chargers carry it so the preview
// exercises the limit-lower-priority toggle; thermostats/water heaters leave it
// off (the common non-stepped case) so the preview also shows the budget-only
// disclosure.
//
// `standingRescue` on the default EV charger seeds the read-only "Already
// allowed (set via Flow)" context line so the design-preview / screenshot
// harness exercises a device that already carries a standing grant; the other
// sample devices omit it so the preview also shows the no-standing case.
export const PREVIEW_CREATE_SMART_TASK_PAYLOADS: Record<string, CreateSmartTaskDevicesPayload> = {
  // Gallery thumbnail: one temperature device and one EV charger so the gallery
  // shows both goal kinds (°C stepper and % stepper).
  default: {
    state: 'ready',
    devices: [
      {
        deviceId: 'preview-hot-water',
        deviceName: 'Hot water',
        kind: 'temperature',
        group: 'heating',
        unitSymbol: '°C',
        goalMin: 5,
        goalMax: 85,
        goalStep: 0.5,
        defaultGoal: 65,
        currentValue: 48,
        supportsLimitLowerPriority: false,
      },
      {
        deviceId: 'preview-ev',
        deviceName: 'Driveway charger',
        kind: 'ev_soc',
        group: 'ev_charger',
        unitSymbol: '%',
        goalMin: 1,
        goalMax: 100,
        goalStep: 1,
        defaultGoal: 80,
        currentValue: 42,
        supportsLimitLowerPriority: true,
        standingRescue: { exemptFromBudget: 'always' },
      },
    ],
  },
  // A longer list (eight eligible devices, grouped thermostats → water heaters →
  // EV) so the picker overflows the widget's fixed height — the harness can then
  // show how the cut-off list reads with no visible scroll affordance.
  overflow: {
    state: 'ready',
    devices: [
      {
        deviceId: 'preview-living',
        deviceName: 'Living room',
        kind: 'temperature',
        group: 'heating',
        unitSymbol: '°C',
        goalMin: 5,
        goalMax: 30,
        goalStep: 0.5,
        defaultGoal: 21,
        currentValue: 19.5,
        supportsLimitLowerPriority: false,
      },
      {
        deviceId: 'preview-bedroom',
        deviceName: 'Bedroom',
        kind: 'temperature',
        group: 'heating',
        unitSymbol: '°C',
        goalMin: 5,
        goalMax: 30,
        goalStep: 0.5,
        defaultGoal: 18,
        currentValue: 17.2,
        supportsLimitLowerPriority: false,
      },
      {
        deviceId: 'preview-bathroom-floor',
        deviceName: 'Bathroom floor',
        kind: 'temperature',
        group: 'heating',
        unitSymbol: '°C',
        goalMin: 5,
        goalMax: 35,
        goalStep: 0.5,
        defaultGoal: 24,
        currentValue: 22.1,
        supportsLimitLowerPriority: false,
      },
      {
        deviceId: 'preview-office',
        deviceName: 'Office',
        kind: 'temperature',
        group: 'heating',
        unitSymbol: '°C',
        goalMin: 5,
        goalMax: 30,
        goalStep: 0.5,
        defaultGoal: 20,
        currentValue: 20.4,
        supportsLimitLowerPriority: false,
      },
      {
        deviceId: 'preview-hot-water',
        deviceName: 'Hot water',
        kind: 'temperature',
        group: 'heating',
        unitSymbol: '°C',
        goalMin: 5,
        goalMax: 85,
        goalStep: 0.5,
        defaultGoal: 65,
        currentValue: 48,
        supportsLimitLowerPriority: false,
      },
      {
        deviceId: 'preview-cabin-water',
        deviceName: 'Cabin water heater',
        kind: 'temperature',
        group: 'heating',
        unitSymbol: '°C',
        goalMin: 5,
        goalMax: 85,
        goalStep: 0.5,
        defaultGoal: 60,
        currentValue: 55,
        supportsLimitLowerPriority: false,
      },
      {
        deviceId: 'preview-ev',
        deviceName: 'Driveway charger',
        kind: 'ev_soc',
        group: 'ev_charger',
        unitSymbol: '%',
        goalMin: 1,
        goalMax: 100,
        goalStep: 1,
        defaultGoal: 80,
        currentValue: 42,
        supportsLimitLowerPriority: true,
      },
      {
        deviceId: 'preview-ev-guest',
        deviceName: 'Guest charger',
        kind: 'ev_soc',
        group: 'ev_charger',
        unitSymbol: '%',
        goalMin: 1,
        goalMax: 100,
        goalStep: 1,
        defaultGoal: 80,
        currentValue: 30,
        supportsLimitLowerPriority: true,
      },
    ],
  },
};

// Default preview state (keeps the original single-payload import working).
export const PREVIEW_CREATE_SMART_TASK_DEVICES = PREVIEW_CREATE_SMART_TASK_PAYLOADS.default;

// Resolve the preview payload for an optional `?state=` selector, falling back
// to the lean gallery thumbnail for an absent/unknown value.
export const resolveCreateSmartTaskPreviewPayload = (
  state: string | null,
): CreateSmartTaskDevicesPayload => (
  state !== null && Object.prototype.hasOwnProperty.call(PREVIEW_CREATE_SMART_TASK_PAYLOADS, state)
    ? PREVIEW_CREATE_SMART_TASK_PAYLOADS[state]
    : PREVIEW_CREATE_SMART_TASK_DEVICES
);
