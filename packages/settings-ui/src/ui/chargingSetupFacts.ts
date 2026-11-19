import {
  CHARGING_ACCESS_PATH, CHARGING_CURRENT_PATH,
  type ChargingAccessStatus, type ChargingCurrentRead,
} from '../../../contracts/src/chargingControl.ts';
import { callApi } from './homey.ts';

export const CHARGING_SETUP_UPDATED = 'charging-setup-updated';
export const VEHICLE_CHARGING_SETUP_HINT = 'Turn on “Control charging through this car” in Setup.';
export const FINISH_CHARGING_SETUP = 'Finish charging setup';

type ChargingSetupRead = { devices: ChargingCurrentRead[]; access: ChargingAccessStatus };
let accepted: ChargingSetupRead | null = null;
let readGeneration = 0;
let acceptedGeneration = 0;
let minimumReadGeneration = 0;

class ChargingSetupReadSupersededError extends Error {
  constructor() {
    super('Charging setup changed while it was loading. Try again.');
    this.name = 'ChargingSetupReadSupersededError';
  }
}

/** Reject reads started before or during a write, while retaining the last accepted observation. */
export const invalidateChargingSetupReads = (): void => {
  minimumReadGeneration = ++readGeneration;
};

export const needsVehicleChargingConsent = (device: ChargingCurrentRead): boolean => (
  device.scope === 'vehicle' && device.setup.confirmation !== 'vehicle'
);

/**
 * Nothing sets this device's charging current: built-in control is not selected
 * and no Flow sets it. A shared installation is left to its coordinating Flow.
 */
export const lacksChargingCurrentRoute = (device: ChargingCurrentRead): boolean => (
  device.setup.method === 'flow' && device.flowCheck === 'clear' && !device.sharedInstallation
);

/** Unknown setup never invents a missing route; failed refreshes retain accepted facts. */
export const chargingCurrentRouteMissing = (deviceId: string): boolean => {
  const device = accepted?.devices.find((candidate) => candidate.deviceId === deviceId);
  return device !== undefined && lacksChargingCurrentRoute(device);
};

/**
 * A charger with no current route has no Flow to report a level back, so its
 * level-report card asks for the wrong thing. Its setup card, the charging
 * setup one or the Automatic review that replaces it, is the one card for it.
 */
export const isReportBackCardForUnroutedCharger = (
  { id, target }: { id: string; target: { kind: string; deviceId?: string } },
  setupCardDeviceIds: ReadonlySet<string>,
): boolean => id.startsWith('level-report:') && target.kind === 'device' && target.deviceId !== undefined
  && chargingCurrentRouteMissing(target.deviceId) && setupCardDeviceIds.has(target.deviceId);

/** Unknown setup never invents a prerequisite; failed refreshes retain accepted facts. */
export const vehicleChargingConsentMissing = (deviceId: string): boolean => {
  const device = accepted?.devices.find((candidate) => candidate.deviceId === deviceId);
  return device !== undefined && needsVehicleChargingConsent(device);
};

/** Both charging surfaces read through this owner, so a late read cannot undo a saved choice. */
export const loadChargingSetup = async (): Promise<ChargingSetupRead> => {
  const generation = ++readGeneration;
  const [devices, access] = await Promise.all([
    callApi<ChargingCurrentRead[]>('GET', CHARGING_CURRENT_PATH),
    callApi<ChargingAccessStatus>('GET', CHARGING_ACCESS_PATH),
  ]);
  if (generation <= minimumReadGeneration || generation < acceptedGeneration) {
    if (accepted !== null && acceptedGeneration > minimumReadGeneration) return accepted;
    throw new ChargingSetupReadSupersededError();
  }
  const next = { devices, access };
  const changed = JSON.stringify(next) !== JSON.stringify(accepted);
  accepted = next;
  acceptedGeneration = generation;
  if (changed) document.dispatchEvent(new Event(CHARGING_SETUP_UPDATED));
  return next;
};
