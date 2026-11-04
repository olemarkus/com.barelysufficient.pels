import { ChargingCurrentControl } from './chargingCurrentControl';
import { HomeBatteryAppActions } from './homeBatteryAppActions';
import type { DeviceHomeySdk } from './transport/deviceHomeySdk';
import { HomeyActionAccess } from './transport/homeyActionAccess';
import type { DeviceTransportOptions } from './transport/transportTypes';
import type { TransportSnapshotStore } from './transport/transportSnapshotStore';
import type { Logger } from '../utils/types';

/**
 * The owner's Homey API key with the one runner of every app action card
 * (`HomeyActionAccess`), and the two owners that run actions on it: the
 * charging-current control and the home-battery action host
 * (`HomeBatteryAppActions`). The device transport builds them once and hands
 * the same ones to its snapshot reads and its writes.
 */
export type HomeyActionOwners = {
  access: HomeyActionAccess;
  batteryAppActions: HomeBatteryAppActions;
  chargingCurrentControl: ChargingCurrentControl;
};

export const createHomeyActionOwners = (
  deviceSdk: DeviceHomeySdk,
  snapshotStore: Pick<TransportSnapshotStore, 'getTrackedRawDevice' | 'getLatestRawDevices'>,
  logger: Logger,
  options: Pick<DeviceTransportOptions, 'acceptedFlowWrites' | 'settings'>,
): HomeyActionOwners => {
  const access = new HomeyActionAccess(deviceSdk.runtime, logger);
  const batteryAppActions = new HomeBatteryAppActions(
    access,
    (deviceId) => snapshotStore.getTrackedRawDevice(deviceId),
    () => snapshotStore.getLatestRawDevices(),
    logger,
  );
  const chargingCurrentControl = new ChargingCurrentControl(
    deviceSdk.runtime.settings, access, logger,
    () => snapshotStore.getLatestRawDevices(),
    () => {
      const health = deviceSdk.getHealth();
      return { connected: health?.subscriptionState === 'subscribed', revision: health?.reconnectCount ?? 0 };
    },
    options.acceptedFlowWrites, options.settings,
  );
  return { access, batteryAppActions, chargingCurrentControl };
};
