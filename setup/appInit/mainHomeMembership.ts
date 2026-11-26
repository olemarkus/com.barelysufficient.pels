import type { AppContext } from '../../lib/app/appContext';
import { readMainHomeMembership } from '../../lib/home/wholeHomeDeviceListing';

/**
 * A device's Main-home membership, read live: membership is published by its own
 * startup step and cleared at app stop, so the port is read per call.
 */
export const bindMainHomeMembership = (ctx: AppContext) => (deviceId: string) => (
  readMainHomeMembership(ctx.homeMembership, deviceId)
);
