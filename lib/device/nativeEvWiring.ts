import type { DeviceControlAdapterSnapshot } from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from './transportDeviceSnapshot';
import type { HomeyDeviceLike } from '../utils/types';
import { isEvPlugStateConnected } from '../../packages/shared-domain/src/evPlugState';
import type { DeviceCapabilityMap } from './managerControl';

const ZAPTEC_NATIVE_REQUIRED_CAPABILITIES = [
  'charging_button',
  'charge_mode',
  'alarm_generic.car_connected',
] as const;
const ZAPTEC_NATIVE_DRIVER_IDS = new Set([
  'homey:app:com.zaptec:go',
  'homey:app:com.zaptec:go2',
  'homey:app:com.zaptec:home',
  'homey:app:com.zaptec:pro',
]);

const hasCapability = (capabilities: readonly string[], capabilityId: string): boolean => (
  capabilities.includes(capabilityId)
);

/**
 * Whether a charger already speaks the official EV vocabulary in FULL — the
 * command axis (`evcharger_charging`) and the plug-state axis
 * (`evcharger_charging_state`) both.
 *
 * BOTH, not either. The two answer different questions and PELS needs both: the
 * boolean says what the charger was told, the enum says what the plug is doing.
 * Accepting one used to be enough, which let a charger exposing only the boolean
 * count as fully wired — so the overlay that would have synthesised the missing
 * plug state was skipped, and the device ran with no plug state at all. Nothing
 * could then end its charging session, which since the state-of-charge age gate
 * was deleted means nothing could retire its battery level either.
 */
export const hasOfficialEvChargerCapabilities = (capabilities: readonly string[]): boolean => (
  hasCapability(capabilities, 'evcharger_charging')
  && hasCapability(capabilities, 'evcharger_charging_state')
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

/**
 * Zaptec reports `charge_mode` as either the raw operation-mode name or its
 * display label, so both spellings of each state are matched here.
 *
 * `Connected_Finishing` and `Charging finished` are the SAME Zaptec state — a
 * session that has ended, which for a car at its own charge limit is where it
 * parks. Both therefore resolve to `plugged_in`, the probed state: a start
 * command may or may not land, and only the probe can tell. They previously
 * disagreed (the enum resolved to `plugged_in_paused`, the label to
 * `plugged_in`), which was invisible while both states were commanded
 * identically; once `plugged_in_paused` stopped being probed
 * (`resolveEvStartProbePosture`, `setup/appInit/toPlanDevice.ts`) the
 * disagreement would have meant a full car commanded every cycle forever, with
 * no probe and no back-off.
 *
 * `Connected_Requesting` is the opposite case and keeps `plugged_in_paused`:
 * the car is asking for current, so the resume is expected to land. That is
 * also the transition a Zaptec makes when a full car starts accepting charge
 * again, which is what releases it from any back-off the finished session
 * accrued.
 */
function resolveZaptecChargingStateFromChargeMode(chargeMode: unknown): string | undefined {
  if (chargeMode === 'Connected_Charging' || chargeMode === 'Charging') return 'plugged_in_charging';
  if (chargeMode === 'Connected_Requesting' || chargeMode === 'Connecting to car') {
    return 'plugged_in_paused';
  }
  if (chargeMode === 'Connected_Finishing' || chargeMode === 'Charging finished') return 'plugged_in';
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
  // Reached only when `charge_mode` is absent or carries a value outside the
  // mapping above (a firmware that renamed a mode, say). All that is known is
  // that a car is attached — not whether a session is running, paused, or
  // finished — so this resolves to the AMBIGUOUS `plugged_in`, which is probed,
  // rather than claiming a resumable pause that is commanded without one.
  if (carConnected === true) return 'plugged_in';
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
      activationRequired: false,
      activationEnabled: true,
    },
    controlWriteCapabilityId,
    controlObservationCapabilityId,
  };
}

export function normalizeNativeEvCapabilityUpdate(params: {
  snapshot: Pick<
    TransportDeviceSnapshot,
    'controlAdapter' | 'binaryControl' | 'evChargingState'
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

  // `alarm_generic.car_connected` carries ONE bit: a car is attached. It says
  // nothing about whether a session is running, paused, or finished, so it may
  // only promote a DISCONNECTED charger — never reclassify a connected one.
  // Reclassifying is how a finished session (`plugged_in`) used to be rewritten
  // as `plugged_in_paused` by a single realtime event: `charge_mode` is
  // change-only push and a car parked at its charge limit never changes it, so
  // the wrong state then stood until the next snapshot refresh (:25 / :55).
  // That matters now that only `plugged_in` is probed — it moved a full car into
  // the lane that is commanded without a probe and never backs off.
  if (capabilityId === 'alarm_generic.car_connected' && typeof value === 'boolean') {
    if (value === false) {
      return [{ capabilityId: 'evcharger_charging_state', value: 'plugged_out' }];
    }
    return [{
      capabilityId: 'evcharger_charging_state',
      value: snapshot.evChargingState !== undefined
        && isEvPlugStateConnected(snapshot.evChargingState)
        ? snapshot.evChargingState
        : 'plugged_in',
    }];
  }

  return [{ capabilityId, value }];
}

export function buildNativeEvObservationCapabilityObj(params: {
  device: HomeyDeviceLike;
  previousSnapshot: Pick<
    TransportDeviceSnapshot,
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
    TransportDeviceSnapshot,
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
