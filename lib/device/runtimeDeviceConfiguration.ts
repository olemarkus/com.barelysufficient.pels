import type { ChargingCurrentControl } from './chargingCurrentControl';
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
    installations: ChargingCurrentControl,
  ) {
    const currentLimitPolicy = new EvChargingCurrentLimitPolicy(settings, cars, snapshots, installations);
    super(currentLimitPolicy);
    this.currentLimits = currentLimitPolicy;
  }
}

