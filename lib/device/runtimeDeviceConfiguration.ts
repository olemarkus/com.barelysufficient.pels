import { DeviceConfigurationStore } from './deviceConfiguration';
import { EvChargingCurrentLimitPolicy, type ChargingCarIdentity } from './evChargingCurrentLimitPolicy';
import type { DeviceControlSettings } from './deviceControlSettings';
import type { TransportSnapshotStore } from './transport/transportSnapshotStore';

/** Runtime configuration and command admission share one live charging-range policy owner. */
export class RuntimeDeviceConfiguration extends DeviceConfigurationStore {
  readonly currentLimits: EvChargingCurrentLimitPolicy;

  constructor(
    settings: Pick<DeviceControlSettings, 'resolveEvCarCurrentLimits' | 'resolveEvChargerCurrentLimits'>,
    cars: ChargingCarIdentity,
    snapshots: TransportSnapshotStore,
  ) {
    const currentLimitPolicy = new EvChargingCurrentLimitPolicy(settings, cars, snapshots);
    super(currentLimitPolicy);
    this.currentLimits = currentLimitPolicy;
  }
}

