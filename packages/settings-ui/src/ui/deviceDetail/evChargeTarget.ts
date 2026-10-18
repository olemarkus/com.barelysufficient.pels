import type { EvChargeTargetConfig, EvChargeTargetSettings } from '../../../../contracts/src/types.ts';
import { EV_CHARGE_TARGET_SETTINGS } from '../../../../shared-domain/src/settings/settingsKeys.ts';
import {
  normalizeEvChargeTargetSettings,
  parseEvChargeTargetPercent,
} from '../../../../shared-domain/src/settings/evChargeTarget.ts';
import { isEvObserved } from '../../../../shared-domain/src/evObservedState.ts';
import { isEvPlugStateConnected } from '../../../../shared-domain/src/evPlugState.ts';
import { resolveDeviceStartPolicy } from '../../../../shared-domain/src/settings/deviceStartPolicy.ts';
import { supportsPowerDevice, type SettingsUiDeviceDetailItem } from '../deviceUtils.ts';
import { isEvChargerDevice } from '../deviceKind.ts';
import {
  deviceDetailChargeTarget,
  deviceDetailChargeTargetEnabled,
  deviceDetailChargeTargetPercent,
  deviceDetailChargeTargetStatus,
  deviceDetailChargeTargetUnknown,
  deviceDetailChargeTargetUnknownHint,
} from '../dom.ts';
import { getSetting } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { state } from '../state.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';

// "Charge to a battery level" on a charger's page. The runtime holds the
// charger off at or above the level (`lib/plan/shedding/chargeTargetHold.ts`);
// this module owns the setting and says, from the battery level the page
// already has, what that means for the car on the cable right now.

const runSerializedChargeTargetWrite = createSerializedAsyncRunner();
// Turning the target on changes nothing until the owner lowers it: a charger
// charged to 100% before it had a target.
const DEFAULT_TARGET_PERCENT = 100;

const UNKNOWN_LEVEL_CHARGES_HINT = "A car that doesn't report its level charges to its own limit.";
const UNKNOWN_LEVEL_HELD_HINT = "A car that doesn't report its level won't charge here. That includes a car "
  + "not selected under Car, a car whose app doesn't share its battery level, and a selected car while its "
  + "app isn't reporting. An energy smart task still charges them in its booked hours.";

export const supportsEvChargeTargetDevice = (device: SettingsUiDeviceDetailItem | null | undefined): boolean => (
  isEvChargerDevice(device)
);

export const loadEvChargeTargetSettings = async () => {
  try {
    state.evChargeTargetSettings = normalizeEvChargeTargetSettings(await getSetting(EV_CHARGE_TARGET_SETTINGS));
  } catch (error) {
    await logSettingsError('Failed to load charge target settings', error, 'loadEvChargeTargetSettings');
    state.evChargeTargetSettings = {};
  }
};

// The hold is a command, so PELS needs a lever: Power-limit control, or the
// "Only PELS starts this device" grant. Without one it only watches. The
// runtime also takes a power reading for any power decision
// (`resolveDeviceControlPosture`); that case has its own line below.
const hasStandingGrant = (deviceId: string): boolean => (
  state.controllableMap[deviceId] === true
  || resolveDeviceStartPolicy(state.deviceStartPolicyMap, deviceId) === 'pels_only'
);

const hasSelectedCar = (deviceId: string): boolean => (
  (state.evCarAssociations[deviceId]?.carIds.length ?? 0) > 0
);

const buildUnreportedStatus = (deviceId: string, config: EvChargeTargetConfig): string => {
  if (!config.chargeBeforeLevelKnown) return 'Battery level not reported. Charging is held until it is.';
  const status = 'Battery level not reported, so the car charges to its own limit.';
  return hasSelectedCar(deviceId)
    ? status
    : `${status} To stop at ${config.targetPercent}%, select the car under Car or report the level with a Flow.`;
};

// A 100% target is the car's own limit and never stops the charger
// (`lib/planInput/chargeTargetHold.ts`); all it can still do is hold a car with
// no level, when the owner turned "Charge before the battery level is known" off.
const FULL_PERCENT = 100;

// What PELS needs a lever for, for this setting.
const describeStop = (config: EvChargeTargetConfig): string => (
  config.targetPercent < FULL_PERCENT
    ? `stop it at ${config.targetPercent}%`
    : 'hold a car until its level is known'
);

export const buildChargeTargetStatus = (device: SettingsUiDeviceDetailItem, config: EvChargeTargetConfig): string => {
  if (config.targetPercent >= FULL_PERCENT && config.chargeBeforeLevelKnown) {
    return 'The car charges to its own limit. Lower the level to stop earlier.';
  }
  if (!supportsPowerDevice(device)) {
    return `PELS has no power reading from this charger, so it cannot ${describeStop(config)}.`;
  }
  if (!hasStandingGrant(device.id)) {
    return `PELS only watches this charger. Turn on Power-limit control to ${describeStop(config)}.`;
  }
  // The plug decides before the level, as the runtime does: with no car on the
  // cable nothing charges and nothing is held, whatever level was last read.
  if (isEvObserved(device) && !isEvPlugStateConnected(device.evChargingState)) return 'No car connected.';
  const level = device.stateOfCharge?.level;
  if (level?.kind === 'known') {
    if (config.targetPercent >= FULL_PERCENT) return `The car charges to its own limit. Now ${level.percent}%.`;
    return level.percent >= config.targetPercent
      ? `Reached ${config.targetPercent}%. Charging stops here unless a smart task asks for more.`
      : `Charges to ${config.targetPercent}%. Now ${level.percent}%.`;
  }
  if (level?.reasonCode === 'not_connected') return 'No car connected.';
  return buildUnreportedStatus(device.id, config);
};

export const renderEvChargeTargetSettings = (device: SettingsUiDeviceDetailItem | null) => {
  if (
    !deviceDetailChargeTarget || !deviceDetailChargeTargetEnabled || !deviceDetailChargeTargetPercent
    || !deviceDetailChargeTargetStatus || !deviceDetailChargeTargetUnknown || !deviceDetailChargeTargetUnknownHint
  ) return;
  const visible = supportsEvChargeTargetDevice(device);
  deviceDetailChargeTarget.hidden = !visible;
  if (!visible || !device) return;

  const config = state.evChargeTargetSettings[device.id];
  const enabled = config !== undefined;
  const chargeBeforeLevelKnown = config?.chargeBeforeLevelKnown ?? true;
  deviceDetailChargeTargetEnabled.selected = enabled;
  deviceDetailChargeTargetPercent.value = String(config?.targetPercent ?? DEFAULT_TARGET_PERCENT);
  // Visible-but-disabled while the target is off, as Charge boost does: the
  // fields say what turning it on offers.
  deviceDetailChargeTargetPercent.disabled = !enabled;
  deviceDetailChargeTargetUnknown.selected = chargeBeforeLevelKnown;
  deviceDetailChargeTargetUnknown.disabled = !enabled;
  deviceDetailChargeTargetUnknownHint.textContent = chargeBeforeLevelKnown
    ? UNKNOWN_LEVEL_CHARGES_HINT
    : UNKNOWN_LEVEL_HELD_HINT;
  const statusText = config ? buildChargeTargetStatus(device, config) : '';
  deviceDetailChargeTargetStatus.textContent = statusText;
  deviceDetailChargeTargetStatus.hidden = statusText.length === 0;
};

export const initEvChargeTargetHandlers = (deps: {
  getCurrentDetailDeviceId: () => string | null;
  refreshOpenDeviceDetail: () => void;
}) => {
  // Each handler states only the change it makes, applied to the freshly read
  // setting inside the serialized write. A whole config captured from the
  // fields could carry a value a pending write's refresh had just redrawn, and
  // undo an edit queued before it.
  const persist = async (
    deviceId: string,
    change: (current: EvChargeTargetConfig | undefined) => EvChargeTargetConfig | null,
  ) => {
    await runSerializedChargeTargetWrite(async () => {
      await writeFreshSetting<EvChargeTargetSettings>({
        key: EV_CHARGE_TARGET_SETTINGS,
        context: 'device detail',
        logMessage: 'Failed to save charge target settings',
        toastMessage: 'Failed to save battery level.',
        // The live snapshot is the fallback, so a transient null SDK read does
        // not erase other chargers' targets.
        fallbackValue: state.evChargeTargetSettings,
        readFresh: (value) => (
          value && typeof value === 'object' && !Array.isArray(value)
            ? normalizeEvChargeTargetSettings(value)
            : null
        ),
        mutate: (currentSettings) => {
          const nextSettings = { ...currentSettings };
          const nextConfig = change(currentSettings[deviceId]);
          if (nextConfig) {
            nextSettings[deviceId] = nextConfig;
          } else {
            delete nextSettings[deviceId];
          }
          return nextSettings;
        },
        commit: (nextSettings) => {
          state.evChargeTargetSettings = nextSettings;
          deps.refreshOpenDeviceDetail();
        },
        rollback: deps.refreshOpenDeviceDetail,
      });
    });
  };

  // A blank or out-of-range field is no target: never clamp it into one (a
  // cleared field read as 0 once saved 1%, which holds every car).
  const readTargetPercentField = (): number | null => (
    parseEvChargeTargetPercent(Number(deviceDetailChargeTargetPercent?.value || Number.NaN))
  );

  deviceDetailChargeTargetEnabled?.addEventListener('change', async () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    if (!deviceId) return;
    const enable = deviceDetailChargeTargetEnabled.selected;
    const targetPercent = readTargetPercentField() ?? DEFAULT_TARGET_PERCENT;
    const chargeBeforeLevelKnown = deviceDetailChargeTargetUnknown?.selected ?? true;
    await persist(deviceId, () => (enable ? { targetPercent, chargeBeforeLevelKnown } : null));
  });

  // An edit to a field applies only while a target is stored; with none, the
  // field is disabled and the switch carries its value in when turned on.
  deviceDetailChargeTargetPercent?.addEventListener('change', async () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    if (!deviceId) return;
    const targetPercent = readTargetPercentField();
    if (targetPercent === null) {
      // Keep the stored target and put it back in the field.
      deps.refreshOpenDeviceDetail();
      return;
    }
    await persist(deviceId, (current) => (current ? { ...current, targetPercent } : null));
  });

  deviceDetailChargeTargetUnknown?.addEventListener('change', async () => {
    const deviceId = deps.getCurrentDetailDeviceId();
    if (!deviceId) return;
    const chargeBeforeLevelKnown = deviceDetailChargeTargetUnknown.selected;
    await persist(deviceId, (current) => (current ? { ...current, chargeBeforeLevelKnown } : null));
  });
};
