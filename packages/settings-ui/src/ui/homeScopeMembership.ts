import { MAIN_HOME_ID } from '../../../shared-domain/src/settings/settingsKeys.ts';

/** The last admitted home-membership data, independent of shell rendering. */
export const homeScopeMembership = {
  membershipByDeviceId: {} as Readonly<Record<string, string>>,
};

export const getHomeIdForUiDevice = (deviceId: string): string => (
  homeScopeMembership.membershipByDeviceId[deviceId] ?? MAIN_HOME_ID
);

/** Same membership port the runtime supplies to the shared mode-priority owner. */
export const uiHomeMembership = { getHomeIdForDevice: getHomeIdForUiDevice };
