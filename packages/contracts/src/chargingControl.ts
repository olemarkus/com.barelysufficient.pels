/** Public access status; the saved Homey credential never leaves its owner. */
export type ChargingAccessStatus = {
  configured: boolean;
  state: 'not_configured' | 'not_checked' | 'ready' | 'permission_denied' | 'unavailable';
};

export const CHARGING_ACCESS_PATH = '/ui_charging_access';
export const CHARGING_ACCESS_CHECK_PATH = '/ui_charging_access/check';

/** Explicit current-control choice; saving an API key never changes it. */
export type ChargingCurrentMethod = 'flow' | 'built_in';
export type ChargingCurrentSetup = {
  method: ChargingCurrentMethod;
  confirmation: 'none' | 'vehicle' | 'single_charger';
};
export type ChargingCurrentRead = {
  deviceId: string;
  name: string;
  setup: ChargingCurrentSetup;
  capabilityWritable: boolean;
  scope: 'installation' | 'vehicle' | 'charger';
  sharedInstallation: boolean;
  flowCheck: 'clear' | 'conflict' | 'unavailable';
  flowNames: string[];
  /**
   * The route in effect: `setup.method`, except that a selected built-in route
   * is held back to the Flow while a Flow is known to set the same current.
   */
  currentRoute: ChargingCurrentMethod;
};
export const CHARGING_CURRENT_PATH = '/ui_charging_current';
