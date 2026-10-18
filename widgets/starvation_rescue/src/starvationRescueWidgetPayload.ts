import { STARVATION_RESCUE_WIDGET_COPY } from '../../../packages/shared-domain/src/planStarvation';
import type {
  StarvationNotListedDevice,
  StarvationRescueDevice,
  StarvationRescueDevicesPayload,
} from '../../../packages/contracts/src/starvationRescue';

export type StarvationRescueWidgetInput = {
  // Currently-starved devices from `App.getStarvedRescueDevices`, or null when
  // the app getter is unavailable (older app, wiring not ready).
  devices: StarvationRescueDevice[] | null | undefined;
  // Limited devices the list leaves out, from `App.getLimitedNotListedDevices`,
  // or null when that getter is unavailable.
  notListed: StarvationNotListedDevice[] | null | undefined;
};

// Shape the runtime starved-device list into the widget payload. An empty (or
// absent) list is the CALM steady state — nothing is being held back — not an
// error, so it carries the reassuring empty subtitle. Built here (not in the
// API handler) so the same shaping is unit-testable without a Homey context.
export const buildStarvationRescueDevicesPayload = (
  input: StarvationRescueWidgetInput,
): StarvationRescueDevicesPayload => {
  const devices = Array.isArray(input.devices) ? input.devices : [];
  const notListed = Array.isArray(input.notListed) ? input.notListed : [];
  if (devices.length === 0) {
    return { state: 'empty', subtitle: STARVATION_RESCUE_WIDGET_COPY.emptySubtitle, notListed };
  }
  return { state: 'ready', devices, notListed };
};
