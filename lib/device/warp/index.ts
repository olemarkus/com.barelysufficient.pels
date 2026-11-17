/**
 * The WARP Charger app (`com.glumpf.warp`, `wallbox` driver, local HTTP) at
 * the SDK seam. See `notes/native-wiring/warp.md`.
 *
 * A write to the app's `evcharger_charging` starts or stops charging, and the
 * app publishes the switch as on only while current flows, which a released
 * session waiting for a full car never is. Its `evcharger_charging_state`
 * tells those apart: `plugged_in` and `plugged_in_charging` are a session
 * PELS lets run, `plugged_in_paused` is one that waits for its release. So
 * the switch is read from the state.
 *
 * The charging current is the charger's external current limit. The app's
 * `wb_set_current` card sets it, and the app's poll publishes it on
 * `warp_current_limit`, or on the `warp_current_limit_pick` picker when the
 * owner shows that one instead. A charger that shows neither has no current
 * reading and gets no built-in current control.
 */
import type { DeviceAdapter, DeviceEvOverlay, SwitchWrite } from '../deviceAdapter';
import { whileBuiltInControlEnabled } from '../deviceAdapter';
import type { DeviceCapabilityMap } from '../managerControl';
import type { CapabilityValue, HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

const DRIVER_IDS = new Set(['homey:app:com.glumpf.warp:wallbox', 'com.glumpf.warp:wallbox']);
const STATE_CAPABILITY = 'evcharger_charging_state';
/** The external current limit, in amps: as a number, or as the picker's string. */
const LIMIT_CAPABILITIES = ['warp_current_limit', 'warp_current_limit_pick'] as const;
const INSTALLATION_CURRENT = 'available_installation_current';
const MIN_CURRENT_A = 6;
const MAX_CURRENT_A = 32;
/** States of a session PELS lets run: drawing, or released and waiting for the car. */
const RUNNING_STATES = new Set(['plugged_in', 'plugged_in_charging']);

function isWarpCharger(device: HomeyDeviceLike): boolean {
  return DRIVER_IDS.has(device.driverId.trim().toLowerCase());
}

function isLimitCapability(capabilityId: string): boolean {
  return LIMIT_CAPABILITIES.some((id) => id === capabilityId);
}

function readCurrentA(value: unknown): number | undefined {
  const currentA = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof currentA === 'number' && Number.isInteger(currentA)
    && currentA >= MIN_CURRENT_A && currentA <= MAX_CURRENT_A ? currentA : undefined;
}

type CurrentReading = { currentA: number; lastUpdated: CapabilityValue<unknown>['lastUpdated'] };

/** The first limit capability that holds a current the charger accepts. */
function readLimit(values: Readonly<Partial<DeviceCapabilityMap>>): CurrentReading | undefined {
  for (const capabilityId of LIMIT_CAPABILITIES) {
    const currentA = readCurrentA(values[capabilityId]?.value);
    if (currentA !== undefined) return { currentA, lastUpdated: values[capabilityId]?.lastUpdated };
  }
  return undefined;
}

/** The switch read from the charging state, and the external limit as the charger's current reading. */
function withWarpObservation(values: DeviceCapabilityMap): DeviceCapabilityMap {
  const state = values[STATE_CAPABILITY];
  const charging = values.evcharger_charging;
  const limit = readLimit(values);
  return {
    ...values,
    ...(charging !== undefined && typeof state?.value === 'string' ? {
      evcharger_charging: { ...charging, value: RUNNING_STATES.has(state.value), lastUpdated: state.lastUpdated },
    } : {}),
    ...(limit ? {
      [INSTALLATION_CURRENT]: { value: limit.currentA, setable: false, lastUpdated: limit.lastUpdated },
    } : {}),
  };
}

function warpOverlay(device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap): DeviceEvOverlay {
  if (!isWarpCharger(device)) return { kind: 'standard', capabilities, capabilityObj: values };
  return {
    kind: 'adapted', capabilities, capabilityObj: withWarpObservation(values),
    // The charger keeps its external limit across a stop, so the planned
    // current goes out before the switch: an old 32 A limit cannot start the session.
    controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true,
      activationOrder: 'current_before_start' },
    binaryTarget: { kind: 'canonical' },
  };
}

export const warpAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isWarpCharger,
  matchesCapabilities: (capabilities) => capabilities.includes('evcharger_charging')
    && capabilities.includes(STATE_CAPABILITY) && capabilities.some((id) => id.startsWith('warp_')),
  overlay: warpOverlay,
  normalize: whileBuiltInControlEnabled((_snapshot, capabilityId, value) => {
    // The app's switch says "current flows now", not whether PELS lets the session run.
    if (capabilityId === 'evcharger_charging') return [];
    if (capabilityId === STATE_CAPABILITY && typeof value === 'string') {
      return [{ capabilityId, value }, { capabilityId: 'evcharger_charging', value: RUNNING_STATES.has(value) }];
    }
    const currentA = isLimitCapability(capabilityId) ? readCurrentA(value) : undefined;
    return currentA === undefined ? [{ capabilityId, value }]
      : [{ capabilityId, value }, { capabilityId: INSTALLATION_CURRENT, value: currentA }];
  }),
  // Read from the charging state, the switch is no observation of PELS's own write.
  switchWrite: (snapshot, request): SwitchWrite => {
    const plain = standardDeviceAdapter.switchWrite(snapshot, request);
    return plain.kind === 'write' && typeof request.value === 'boolean'
      ? { ...plain, readBackAsWritten: false } : plain;
  },
  recoverSwitchWrite: (snapshot, _raw, request) => warpAdapter.switchWrite(snapshot, request),
  currentBindings: (device) => isWarpCharger(device)
    && LIMIT_CAPABILITIES.some((id) => device.capabilities.includes(id)) ? [{
      deviceId: device.id,
      current: { kind: 'action_only' },
      appUri: 'homey:app:com.glumpf.warp',
      actionId: 'wb_set_current',
      scope: { kind: 'charger' },
      sharesInstallation: () => false,
      currentArguments: (currentA) => ({ current: currentA }),
    }] : [],
};
