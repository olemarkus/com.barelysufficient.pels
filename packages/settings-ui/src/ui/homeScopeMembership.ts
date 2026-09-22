import { MAIN_HOME_ID } from '../../../contracts/src/settingsKeys.ts';

/** The last admitted home-membership data, independent of shell rendering. */
export const homeScopeMembership = {
  runtimeActive: false,
  membershipByDeviceId: {} as Readonly<Record<string, string>>,
};

export const getHomeIdForUiDevice = (deviceId: string): string => (
  homeScopeMembership.runtimeActive
    ? homeScopeMembership.membershipByDeviceId[deviceId] ?? MAIN_HOME_ID
    : MAIN_HOME_ID
);

/** Same membership port the runtime supplies to the shared mode-priority owner. */
export const uiHomeMembership = { getHomeIdForDevice: getHomeIdForUiDevice };
