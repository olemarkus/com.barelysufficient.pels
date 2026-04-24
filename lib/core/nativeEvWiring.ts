import type {
  HomeyDeviceLike,
  DeviceControlAdapterSnapshot,
  TargetDeviceSnapshot,
} from '../utils/types';
import type { DeviceCapabilityMap } from './deviceManagerControl';

const ZAPTEC_NATIVE_REQUIRED_CAPABILITIES = [
  'charging_button',
  'charge_mode',
  'alarm_generic.car_connected',
] as const;
const ZAPTEC_NATIVE_DRIVER_IDS = new Set([
  'homey:app:com.zaptec:go',
  'homey:app:com.zaptec:go2',
]);

const hasCapability = (capabilities: readonly string[], capabilityId: string): boolean => (
  capabilities.includes(capabilityId)
);

export const hasOfficialEvChargerCapabilities = (capabilities: readonly string[]): boolean => (
  hasCapability(capabilities, 'evcharger_charging')
  || hasCapability(capabilities, 'evcharger_charging_state')
);

const hasAllZaptecNativeCapabilities = (capabilities: readonly string[]): boolean => (
  ZAPTEC_NATIVE_REQUIRED_CAPABILITIES.every((capabilityId) => hasCapability(capabilities, capabilityId))
);

const normalizeText = (value: unknown): string => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

function resolveLatestLastUpdated(...values: Array<string | number | Date | null | undefined>) {
  const timestamps = values.flatMap((value) => {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? [value.getTime()] : [];
    if (typeof value === 'number') return Number.isFinite(value) ? [value] : [];
    if (typeof value !== 'string') return [];
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? [parsed] : [];
  });
  if (timestamps.length === 0) return undefined;
  return new Date(Math.max(...timestamps)).toISOString();
}

function resolveZaptecChargingStateFromChargeMode(chargeMode: unknown): string | undefined {
  if (chargeMode === 'Connected_Charging' || chargeMode === 'Charging') return 'plugged_in_charging';
  if (
    chargeMode === 'Connected_Requesting'
    || chargeMode === 'Connected_Finishing'
    || chargeMode === 'Connecting to car'
    || chargeMode === 'Charging finished'
  ) {
    return 'plugged_in_paused';
  }
  if (chargeMode === 'Disconnected') return 'plugged_out';
  return undefined;
}

export function isZaptecGoNativeWiringCandidate(device: HomeyDeviceLike): boolean {
  if (normalizeText(device.class) !== 'evcharger') return false;

  const capabilities = Array.isArray(device.capabilities) ? device.capabilities : [];
  if (!hasAllZaptecNativeCapabilities(capabilities)) return false;

  const driverId = normalizeText(device.driverId);
  return ZAPTEC_NATIVE_DRIVER_IDS.has(driverId);
}

function resolveZaptecChargingState(capabilityObj: DeviceCapabilityMap): string | undefined {
  const chargeMode = capabilityObj.charge_mode?.value;
  const carConnected = capabilityObj['alarm_generic.car_connected']?.value;

  const chargeModeState = resolveZaptecChargingStateFromChargeMode(chargeMode);
  if (chargeModeState) return chargeModeState;
  if (carConnected === true) return 'plugged_in_paused';
  if (carConnected === false) return 'plugged_out';
  return undefined;
}

function resolveZaptecChargingValue(capabilityObj: DeviceCapabilityMap): boolean | undefined {
  const chargingButton = capabilityObj.charging_button?.value;
  if (typeof chargingButton === 'boolean') return chargingButton;

  const evChargingState = resolveZaptecChargingState(capabilityObj);
  if (evChargingState === 'plugged_in_charging' || evChargingState === 'plugged_in_paused') return true;
  if (evChargingState === 'plugged_out') return false;
  return undefined;
}

export function applyNativeEvWiringOverlay(params: {
  device: HomeyDeviceLike;
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  nativeWiringEnabled: boolean;
}): {
  capabilities: string[];
  capabilityObj: DeviceCapabilityMap;
  controlAdapter?: DeviceControlAdapterSnapshot;
  controlWriteCapabilityId?: string;
  controlObservationCapabilityId?: string;
} {
  const {
    device,
    capabilities,
    capabilityObj,
    nativeWiringEnabled,
  } = params;
  const nativeWiringSupported = isZaptecGoNativeWiringCandidate(device);
  const nativeEvCapabilitiesPresent = hasOfficialEvChargerCapabilities(capabilities);
  if (!nativeWiringSupported) {
    return {
      capabilities,
      capabilityObj,
    };
  }
  if (nativeEvCapabilitiesPresent) {
    return {
      capabilities,
      capabilityObj,
      controlAdapter: {
        kind: 'capability_adapter',
        activationRequired: false,
        activationEnabled: false,
      },
    };
  }
  if (!nativeWiringEnabled) {
    return {
      capabilities,
      capabilityObj,
      controlAdapter: {
        kind: 'capability_adapter',
        activationRequired: true,
        activationEnabled: false,
      },
    };
  }

  const nextCapabilities = [...capabilities];
  const nextCapabilityObj: DeviceCapabilityMap = { ...capabilityObj };
  let controlWriteCapabilityId: string | undefined;
  let controlObservationCapabilityId: string | undefined;

  if (!hasCapability(nextCapabilities, 'evcharger_charging')) {
    nextCapabilities.push('evcharger_charging');
    nextCapabilityObj.evcharger_charging = {
      value: resolveZaptecChargingValue(nextCapabilityObj),
      setable: true,
      lastUpdated: resolveLatestLastUpdated(
        nextCapabilityObj.charging_button?.lastUpdated,
        nextCapabilityObj.charge_mode?.lastUpdated,
      ),
    };
    controlWriteCapabilityId = 'charging_button';
    controlObservationCapabilityId = 'evcharger_charging';
  }

  if (!hasCapability(nextCapabilities, 'evcharger_charging_state')) {
    nextCapabilities.push('evcharger_charging_state');
    nextCapabilityObj.evcharger_charging_state = {
      value: resolveZaptecChargingState(nextCapabilityObj),
      lastUpdated: resolveLatestLastUpdated(
        nextCapabilityObj.charge_mode?.lastUpdated,
        nextCapabilityObj['alarm_generic.car_connected']?.lastUpdated,
      ),
    };
  }

  return {
    capabilities: nextCapabilities,
    capabilityObj: nextCapabilityObj,
    controlAdapter: {
      kind: 'capability_adapter',
      activationRequired: true,
      activationEnabled: true,
    },
    controlWriteCapabilityId,
    controlObservationCapabilityId,
  };
}

export function normalizeNativeEvCapabilityUpdate(params: {
  snapshot: Pick<
    TargetDeviceSnapshot,
    'controlAdapter' | 'currentOn' | 'evChargingState'
  >;
  capabilityId: string;
  value: unknown;
}): Array<{ capabilityId: string; value: unknown }> {
  const { snapshot, capabilityId, value } = params;
  if (snapshot.controlAdapter?.activationEnabled !== true) {
    return [{ capabilityId, value }];
  }

  if (capabilityId === 'charging_button' && typeof value === 'boolean') {
    return [{ capabilityId: 'evcharger_charging', value }];
  }

  if (capabilityId === 'charge_mode' && typeof value === 'string') {
    const nextState = resolveZaptecChargingStateFromChargeMode(value);
    return nextState ? [{ capabilityId: 'evcharger_charging_state', value: nextState }] : [];
  }

  if (capabilityId === 'alarm_generic.car_connected' && typeof value === 'boolean') {
    if (value === false) {
      return [{ capabilityId: 'evcharger_charging_state', value: 'plugged_out' }];
    }
    return [{
      capabilityId: 'evcharger_charging_state',
      value: snapshot.evChargingState === 'plugged_in_charging'
        ? 'plugged_in_charging'
        : 'plugged_in_paused',
    }];
  }

  return [{ capabilityId, value }];
}

export function buildNativeEvObservationCapabilityObj(params: {
  device: HomeyDeviceLike;
  previousSnapshot: Pick<
    TargetDeviceSnapshot,
    'controlAdapter'
  > | null | undefined;
}): DeviceCapabilityMap {
  const { device, previousSnapshot } = params;
  const nextCapabilityObj: DeviceCapabilityMap = {
    ...((device.capabilitiesObj ?? {}) as DeviceCapabilityMap),
  };
  if (previousSnapshot?.controlAdapter?.activationEnabled !== true) {
    return nextCapabilityObj;
  }

  if (
    nextCapabilityObj.evcharger_charging === undefined
    && typeof nextCapabilityObj.charging_button?.value === 'boolean'
  ) {
    nextCapabilityObj.evcharger_charging = {
      value: nextCapabilityObj.charging_button.value,
      lastUpdated: nextCapabilityObj.charging_button.lastUpdated,
    };
  }

  if (nextCapabilityObj.evcharger_charging_state === undefined) {
    const evChargingState = resolveZaptecChargingState(nextCapabilityObj);
    if (evChargingState !== undefined) {
      nextCapabilityObj.evcharger_charging_state = {
        value: evChargingState,
        lastUpdated: resolveLatestLastUpdated(
          nextCapabilityObj.charge_mode?.lastUpdated,
          nextCapabilityObj['alarm_generic.car_connected']?.lastUpdated,
        ),
      };
    }
  }

  return nextCapabilityObj;
}

export function buildNativeEvObservationDevice(params: {
  device: HomeyDeviceLike;
  previousSnapshot: Pick<
    TargetDeviceSnapshot,
    'controlAdapter'
  > | null | undefined;
}): HomeyDeviceLike {
  const { device, previousSnapshot } = params;
  return {
    ...device,
    capabilitiesObj: buildNativeEvObservationCapabilityObj({
      device,
      previousSnapshot,
    }),
  };
}
