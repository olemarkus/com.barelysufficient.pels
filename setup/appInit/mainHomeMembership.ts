import type { AppContext } from '../../lib/app/appContext';
import { isSettledMainHomeMember } from '../../lib/home/wholeHomeDeviceListing';

/**
 * Whether a device is a Main-home member on settled membership
 * (`isSettledMainHomeMember`), read live: membership is published by its own
 * startup step and cleared at app stop, so the port is read per call.
 */
export const bindSettledMainHomeMember = (ctx: AppContext) => (deviceId: string): boolean => (
  isSettledMainHomeMember(ctx.homeMembership, deviceId)
);
