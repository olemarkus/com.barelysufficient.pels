import type { SettingsPort } from '../ports/homeyRuntime';
import {
  isShedBehaviorsSetting,
  readShedBehaviors,
  resolveShedBehavior,
  type ConfiguredShedBehavior,
} from '../../packages/shared-domain/src/settings/shedBehaviors';
import type {
  DeviceControlProfile,
  DeviceControlProfiles,
  DevicePowerControlMode,
  DevicePowerControlModes,
  EvBoostConfig,
  EvBoostSettings,
  EvChargeTargetConfig,
  EvChargeTargetSettings,
  EvCarAssociations,
  TargetDeviceSnapshot,
  TargetPowerReachabilityState,
  TemperatureBoostConfig,
  TemperatureBoostSettings,
} from '../../packages/contracts/src/types';
import { isBooleanMap, isDeviceControlProfiles, isPlainObjectRecord, isStringMap } from '../utils/appTypeGuards';
import { normalizeEvBoostSettings } from '../../packages/shared-domain/src/settings/evBoost';
import { normalizeEvChargeTargetSettings } from '../../packages/shared-domain/src/settings/evChargeTarget';
import { normalizeTemperatureBoostSettings } from '../../packages/shared-domain/src/settings/temperatureBoost';
import { normalizeEvCarAssociations } from '../../packages/shared-domain/src/settings/evCarAssociations';
import {
  readEvChargingCurrentLimitsSetting, resolveEvChargingCurrentPolicy,
  type EvChargingCurrentLimitsRead, type EvChargingCurrentPolicy,
} from './evChargingCurrentLimitSettings';
import { normalizeDeviceControlProfiles } from '../../packages/shared-domain/src/deviceControlProfiles';
import { isDevicePowerControlModes } from '../../packages/shared-domain/src/settings/devicePowerControlModes';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import {
  normalizeCompleteTargetPowerReachabilityByDevice,
  normalizeDeviceTargetPowerConfigs,
} from '../utils/targetPowerConfig';
import {
  resolveValidTargetPowerReachability,
  type DeviceTargetPowerConfigsWithReachability,
  type TargetPowerConfigWithReachability,
} from './targetPowerReachability';
import {
  isDeviceStartPolicyMap,
  type DeviceStartPolicy,
} from '../../packages/shared-domain/src/settings/deviceStartPolicy';
import {
  isDevicePhaseConnectionMap,
  type DevicePhaseConnection,
} from '../../packages/shared-domain/src/settings/devicePhaseConnections';
import {
  BUDGET_EXEMPT_DEVICES,
  CONTROLLABLE_DEVICES,
  DEVICE_CONTROL_PROFILES,
  DEVICE_DRIVER_OVERRIDES,
  DEVICE_PHASE_CONNECTIONS,
  DEVICE_START_POLICIES,
  DEVICE_TARGET_POWER_CONFIGS,
  DEVICE_POWER_CONTROL_MODES,
  DEVICE_TARGET_POWER_REACHABILITY,
  EV_BOOST_SETTINGS,
  EV_CHARGE_TARGET_SETTINGS,
  EV_CAR_ASSOCIATIONS,
  EV_CAR_CURRENT_LIMITS,
  EV_CHARGER_CURRENT_LIMITS,
  MANAGED_DEVICES,
  NATIVE_EV_WIRING_DEVICES,
  OVERSHOOT_BEHAVIORS,
  TEMPERATURE_BOOST_SETTINGS,
} from '../utils/settingsKeys';
import {
  readTemperatureControlDisabledDevicesSetting,
  resolveTemperatureControlDisabled,
} from './temperatureControlSettings';

/** What became of a probe's reachability (`adoptTargetPowerReachability`). */
export type TargetPowerReachabilityAdoption =
  | { state: 'invalid' }
  | {
    state: 'adopted' | 'unchanged';
    /** The candidate config the reachability was resolved against. */
    config: TargetPowerConfigWithReachability;
    reachability: TargetPowerReachabilityState;
  };

/** Whether the temperature-command policy has been read this run. */
export type TemperatureControlPolicyState = 'unavailable' | 'resolved';

type BooleanMap = Readonly<Record<string, boolean>>;

/** One generation of the maps, adopted as a whole. */
type DeviceControlMaps = {
  readonly controllable: BooleanMap;
  readonly managed: BooleanMap;
  readonly managedFilterActive: boolean;
  readonly budgetExempt: BooleanMap;
  readonly phaseConnections: Readonly<Record<string, DevicePhaseConnection>>;
  readonly startPolicies: Readonly<Record<string, DeviceStartPolicy>>;
  readonly temperatureControl: TemperatureControlPolicy;
  readonly temperatureBoost: TemperatureBoostSettings;
  readonly evBoost: EvBoostSettings;
  readonly evChargeTargets: EvChargeTargetSettings;
  readonly evCarAssociations: EvCarAssociations;
  readonly evCarCurrentLimits: EvChargingCurrentLimitsRead;
  readonly evChargerCurrentLimits: EvChargingCurrentLimitsRead;
  readonly nativeEvWiring: NativeWiringPolicy;
  readonly driverOverrides: Readonly<Record<string, string>>;
  readonly controlProfiles: DeviceControlProfilesRead;
  readonly targetPowerConfigs: DeviceTargetPowerConfigsRead;
  readonly powerControlModes: PowerControlModePolicy;
  readonly shedBehaviors: Readonly<Record<string, ConfiguredShedBehavior>>;
};

type TemperatureControlPolicy = {
  devices: Record<string, boolean>;
  state: TemperatureControlPolicyState;
};

type PowerControlModePolicy = {
  modes: DevicePowerControlModes;
  state: 'unavailable' | 'resolved';
};

type NativeWiringPolicy = {
  devices: BooleanMap;
  state: 'unavailable' | 'resolved';
};

type DeviceControlProfilesRead = {
  profiles: DeviceControlProfiles;
  state: 'unavailable' | 'resolved';
};

type DeviceTargetPowerConfigsRead = {
  configs: DeviceTargetPowerConfigsWithReachability;
  authoredDeviceIds: ReadonlySet<string>;
  state: 'unavailable' | 'resolved';
};

// A never-written key is no connection set; a malformed read keeps the last good
// map, because a transient miss is not an owner who cleared every connection.
const readPhaseConnections = (
  raw: unknown,
  current: Readonly<Record<string, DevicePhaseConnection>>,
): Readonly<Record<string, DevicePhaseConnection>> => {
  if (raw === undefined || raw === null) return {};
  return isDevicePhaseConnectionMap(raw) ? raw : current;
};

const keep = <T>(raw: unknown, accept: (value: unknown) => value is T, current: T): T => (
  accept(raw) ? raw : current
);

/** A held generation owns the map paired with its derived admission decision. */
const acceptManagedDevices = (raw: unknown, current: BooleanMap): BooleanMap => (
  isBooleanMap(raw) ? { ...raw } : current
);

const normalizeOrKeep = <T>(raw: unknown, normalize: (value: unknown) => T, current: T): T => (
  isPlainObjectRecord(raw) ? normalize(raw) : current
);

/**
 * The device-control settings the planner-input projection reads, as the
 * runtime holds them. `DeviceControlSettings` is the implementation; setup
 * hands it over whole.
 */
export type DeviceControlSettingsRead = Pick<DeviceControlSettings,
  | 'getDeviceTargetPowerConfig'
  | 'getTemperatureBoostConfig'
  | 'getEvBoostConfig'
  | 'getEvChargeTargetConfig'
  | 'deviceStartPolicies'
  | 'controllableDevices'
  | 'isBudgetExempt'
  | 'getDevicePhaseConnection'
>;

/**
 * The owner's per-device control configuration, as the running app holds it:
 * which devices PELS manages and may limit, their start policies, temperature
 * command authority, boost settings, charger battery targets, car associations, native EV wiring
 * choices, driver overrides, control profiles, target-power candidates and
 * shed behaviours.
 *
 * Every map is read from its settings key at {@link reload}, the maps are
 * adopted together once every read has answered, and each is kept as last
 * accepted: a read that is not the map keeps the one already held, because
 * a transient SDK miss is not an owner who cleared every entry. A boost or
 * car-association read that is a map is normalized, dropping the entries it
 * cannot use.
 */
export class DeviceControlSettings {
  private maps: DeviceControlMaps = {
    controllable: {},
    managed: {},
    managedFilterActive: false,
    budgetExempt: {},
    phaseConnections: {},
    startPolicies: {},
    temperatureControl: { devices: {}, state: 'unavailable' },
    temperatureBoost: {},
    evBoost: {},
    evChargeTargets: {},
    evCarAssociations: {},
    evCarCurrentLimits: { state: 'unavailable' },
    evChargerCurrentLimits: { state: 'unavailable' },
    nativeEvWiring: { devices: {}, state: 'unavailable' },
    driverOverrides: {},
    controlProfiles: { profiles: {}, state: 'unavailable' },
    targetPowerConfigs: { configs: {}, authoredDeviceIds: new Set(), state: 'unavailable' },
    powerControlModes: { modes: {}, state: 'unavailable' },
    shedBehaviors: {},
  };

  constructor(private readonly settings: Pick<SettingsPort, 'get' | 'getKeys'>) {}

  /** The runtime-held Power-limit control map (`controllable_devices`), the one the planner reads. */
  get controllableDevices(): BooleanMap { return this.maps.controllable; }
  get managedDevices(): BooleanMap { return this.maps.managed; }
  /** Per-device start authority; absence reads as `'unrestricted'`. */
  get deviceStartPolicies(): Readonly<Record<string, DeviceStartPolicy>> { return this.maps.startPolicies; }
  /** Explicit native EV wiring choices; a device with no entry follows the automatic decision. */
  get nativeEvWiringDevices(): BooleanMap { return this.maps.nativeEvWiring.devices; }
  get deviceTargetPowerConfigs(): DeviceTargetPowerConfigsWithReachability {
    return this.maps.targetPowerConfigs.configs;
  }
  get temperatureControlPolicyState(): TemperatureControlPolicyState { return this.maps.temperatureControl.state; }

  /** The owner's Managed choice for an ordinary device; batteries and solar answer in `resolveDeviceManagedState`. */
  isManaged(deviceId: string): boolean { return this.maps.managed[deviceId] === true; }
  /** The owner's Power-limit control choice (`resolveCapacityControlEnabled` decides). */
  isControllable(deviceId: string): boolean { return this.maps.controllable[deviceId] === true; }
  /**
   * Whether the owner has managed any device; until then every device is read.
   * Explicit `false` entries alone must NOT activate it, or a fresh install
   * would flip from "all devices visible" to "only the explicit-true devices"
   * merely because settings hold opt-outs.
   */
  isManagedFilterActive(): boolean { return this.maps.managedFilterActive; }
  isBudgetExempt(deviceId: string): boolean { return this.maps.budgetExempt[deviceId] === true; }
  /** The owner's Electrical connection; `undefined` is Automatic, an answer rather than a gap. */
  getDevicePhaseConnection(deviceId: string): DevicePhaseConnection | undefined {
    return this.maps.phaseConnections[deviceId];
  }
  getTemperatureBoostConfig(deviceId: string): TemperatureBoostConfig | undefined {
    return this.maps.temperatureBoost[deviceId];
  }
  getEvBoostConfig(deviceId: string): EvBoostConfig | undefined { return this.maps.evBoost[deviceId]; }
  /** The charger's target battery level; `undefined` is "no target", an answer rather than a gap. */
  getEvChargeTargetConfig(deviceId: string): EvChargeTargetConfig | undefined {
    return this.maps.evChargeTargets[deviceId];
  }
  getEvCarAssociationCarIds(deviceId: string): string[] { return this.maps.evCarAssociations[deviceId]?.carIds ?? []; }
  resolveEvCarCurrentLimits(carId: string): EvChargingCurrentPolicy {
    if (this.maps.evCarCurrentLimits.state === 'unavailable') {
      this.maps = { ...this.maps,
        evCarCurrentLimits: readEvChargingCurrentLimitsSetting(
          this.settings, EV_CAR_CURRENT_LIMITS, this.maps.evCarCurrentLimits,
        ) };
    }
    return resolveEvChargingCurrentPolicy(this.maps.evCarCurrentLimits, carId);
  }
  resolveEvChargerCurrentLimits(deviceId: string): EvChargingCurrentPolicy {
    if (this.maps.evChargerCurrentLimits.state === 'unavailable') {
      this.maps = { ...this.maps,
        evChargerCurrentLimits: readEvChargingCurrentLimitsSetting(
          this.settings, EV_CHARGER_CURRENT_LIMITS, this.maps.evChargerCurrentLimits,
        ) };
    }
    return resolveEvChargingCurrentPolicy(this.maps.evChargerCurrentLimits, deviceId);
  }
  getDeviceControlProfile(deviceId: string): DeviceControlProfile | undefined {
    return this.maps.controlProfiles.profiles[deviceId];
  }
  getDeviceTargetPowerConfig(deviceId: string): TargetPowerConfigWithReachability | undefined {
    return this.maps.targetPowerConfigs.configs[deviceId];
  }
  getDevicePowerControlMode(deviceId: string): DevicePowerControlMode | undefined {
    const { modes } = this.maps.powerControlModes;
    return Object.hasOwn(modes, deviceId) ? modes[deviceId] : undefined;
  }
  resolveDevicePowerControlMode(deviceId: string, requiresManualCurrentControl: boolean): DevicePowerControlMode {
    if (this.maps.powerControlModes.state === 'unavailable') {
      this.maps = { ...this.maps, powerControlModes: this.readPowerControlModes() };
    }
    // An unreadable saved Manual choice must not authorize automatic takeover.
    if (this.maps.powerControlModes.state === 'unavailable') return 'manual';
    const configured = this.getDevicePowerControlMode(deviceId);
    if (configured) return configured;
    return this.requiresManualModel(deviceId) || requiresManualCurrentControl ? 'manual' : 'automatic';
  }

  private requiresManualModel(deviceId: string): boolean {
    if (this.maps.controlProfiles.state === 'unavailable' || this.maps.targetPowerConfigs.state === 'unavailable'
      || this.maps.nativeEvWiring.state === 'unavailable') {
      this.maps = {
        ...this.maps, controlProfiles: this.readControlProfiles(), targetPowerConfigs: this.readTargetPowerConfigs(),
        nativeEvWiring: this.readNativeWiringPolicy(),
      };
    }
    const { controlProfiles, targetPowerConfigs } = this.maps;
    return controlProfiles.state === 'unavailable' || targetPowerConfigs.state === 'unavailable'
      || targetPowerConfigs.authoredDeviceIds.has(deviceId) || Object.hasOwn(controlProfiles.profiles, deviceId)
      || this.maps.nativeEvWiring.state === 'unavailable' || Object.hasOwn(this.maps.nativeEvWiring.devices, deviceId);
  }
  getConfiguredShedBehavior(deviceId: string): ConfiguredShedBehavior {
    return resolveShedBehavior(this.maps.shedBehaviors, deviceId);
  }
  getDeviceDriverIdOverride(deviceId: string): string | undefined {
    const override = this.maps.driverOverrides[deviceId]?.trim();
    return override || undefined;
  }

  /**
   * Whether PELS may command this device's temperature. A policy that has not
   * been read yet is re-read here, at command-authority time, and stays fail
   * closed for a temperature device until it resolves.
   */
  isTemperatureControlDisabled(
    deviceId: string,
    device: Pick<TargetDeviceSnapshot, 'deviceType'> | undefined,
  ): boolean {
    if (this.maps.temperatureControl.state === 'unavailable') this.reloadTemperatureControlPolicy();
    const { temperatureControl } = this.maps;
    return resolveTemperatureControlDisabled(temperatureControl.state, temperatureControl.devices, deviceId, device);
  }

  /** Re-read only the validated live temperature-command authorization map. */
  reloadTemperatureControlPolicy(): void {
    this.maps = { ...this.maps, temperatureControl: this.readTemperatureControlPolicy() };
  }

  /**
   * Adopt the reachability a probe established for the device's current
   * candidate config, ahead of its persisted write: operational convergence is
   * independent of Homey settings availability. `invalid` when the device has
   * no config or the reachability does not fit it; `unchanged` when the held
   * reachability already says the same.
   */
  adoptTargetPowerReachability(
    deviceId: string,
    reachability: TargetPowerReachabilityState,
  ): TargetPowerReachabilityAdoption {
    const config = this.maps.targetPowerConfigs.configs[deviceId];
    if (!config) return { state: 'invalid' };
    const resolved = resolveValidTargetPowerReachability({ ...config, reachability });
    if (!resolved) return { state: 'invalid' };
    const current = resolveValidTargetPowerReachability(config);
    const changed = !current
      || current.profileFingerprint !== resolved.profileFingerprint
      || current.maxReachedPowerW !== resolved.maxReachedPowerW
      || current.probeFailureCount !== resolved.probeFailureCount
      || current.nextProbeAtMs !== resolved.nextProbeAtMs;
    if (changed) {
      this.maps = {
        ...this.maps,
        targetPowerConfigs: { ...this.maps.targetPowerConfigs,
          configs: { ...this.maps.targetPowerConfigs.configs, [deviceId]: { ...config, reachability: resolved } } },
      };
    }
    return { state: changed ? 'adopted' : 'unchanged', config, reachability: resolved };
  }

  /**
   * Re-read every map, and adopt them together only once every read has
   * answered: a read that throws part-way leaves the whole previous generation
   * in place rather than a mix of new and old maps.
   */
  reload(): void {
    const { settings, maps: current } = this;
    const driverOverrides = settings.get(DEVICE_DRIVER_OVERRIDES);
    // A read that is not the map keeps the one already held: a transient miss is
    // not an owner who cleared every limit.
    const shedBehaviors = settings.get(OVERSHOOT_BEHAVIORS);
    const managed = acceptManagedDevices(settings.get(MANAGED_DEVICES), current.managed);
    const managedFilterActive = Object.values(managed).some((value) => value === true);
    this.maps = {
      controllable: keep(settings.get(CONTROLLABLE_DEVICES), isBooleanMap, current.controllable),
      managed,
      managedFilterActive,
      budgetExempt: keep(settings.get(BUDGET_EXEMPT_DEVICES), isBooleanMap, current.budgetExempt),
      phaseConnections: readPhaseConnections(settings.get(DEVICE_PHASE_CONNECTIONS), current.phaseConnections),
      // All-or-nothing, and a rejected read keeps the last good map: a transient
      // SDK miss must never look like an owner who just cleared every policy.
      startPolicies: keep(settings.get(DEVICE_START_POLICIES), isDeviceStartPolicyMap, current.startPolicies),
      temperatureControl: this.readTemperatureControlPolicy(),
      temperatureBoost: normalizeOrKeep(
        settings.get(TEMPERATURE_BOOST_SETTINGS), normalizeTemperatureBoostSettings, current.temperatureBoost,
      ),
      evBoost: normalizeOrKeep(settings.get(EV_BOOST_SETTINGS), normalizeEvBoostSettings, current.evBoost),
      evChargeTargets: normalizeOrKeep(
        settings.get(EV_CHARGE_TARGET_SETTINGS), normalizeEvChargeTargetSettings, current.evChargeTargets,
      ),
      evCarAssociations: normalizeOrKeep(
        settings.get(EV_CAR_ASSOCIATIONS), normalizeEvCarAssociations, current.evCarAssociations,
      ),
      evCarCurrentLimits: readEvChargingCurrentLimitsSetting(
        settings, EV_CAR_CURRENT_LIMITS, current.evCarCurrentLimits,
      ),
      evChargerCurrentLimits: readEvChargingCurrentLimitsSetting(
        settings, EV_CHARGER_CURRENT_LIMITS, current.evChargerCurrentLimits,
      ),
      nativeEvWiring: this.readNativeWiringPolicy(),
      driverOverrides: isStringMap(driverOverrides) ? normalizeStringMap(driverOverrides) : current.driverOverrides,
      controlProfiles: this.readControlProfiles(),
      targetPowerConfigs: this.readTargetPowerConfigs(),
      powerControlModes: this.readPowerControlModes(),
      shedBehaviors: isShedBehaviorsSetting(shedBehaviors) ? readShedBehaviors(shedBehaviors) : current.shedBehaviors,
    };
  }

  private readTemperatureControlPolicy(): TemperatureControlPolicy {
    return readTemperatureControlDisabledDevicesSetting({
      settings: this.settings,
      current: this.maps.temperatureControl,
    });
  }

  private readPowerControlModes(): PowerControlModePolicy {
    const current = this.maps.powerControlModes;
    try {
      const raw = this.settings.get(DEVICE_POWER_CONTROL_MODES);
      if (isDevicePowerControlModes(raw)) return { modes: raw, state: 'resolved' };
      if (this.isAbsentSetting(DEVICE_POWER_CONTROL_MODES, raw)) return { modes: {}, state: 'resolved' };
    } catch {
      // A failed read keeps the accepted choice, including an unresolved boot.
    }
    return current;
  }

  private readNativeWiringPolicy(): NativeWiringPolicy {
    try {
      const raw = this.settings.get(NATIVE_EV_WIRING_DEVICES);
      if (isBooleanMap(raw)) return { devices: raw, state: 'resolved' };
      if (this.isAbsentSetting(NATIVE_EV_WIRING_DEVICES, raw)) return { devices: {}, state: 'resolved' };
    } catch { /* An unread choice cannot authorize replacing the owner's manual model. */ }
    return this.maps.nativeEvWiring;
  }

  private isAbsentSetting(key: string, raw: unknown): boolean {
    if (raw !== null && raw !== undefined) return false;
    const keys = readSettingsKeyList(this.settings);
    return keys.status === 'resolved' && !keys.keys.includes(key);
  }

  private readControlProfiles(): DeviceControlProfilesRead {
    const current = this.maps.controlProfiles;
    try {
      const raw = this.settings.get(DEVICE_CONTROL_PROFILES);
      const profiles = isDeviceControlProfiles(raw) ? normalizeDeviceControlProfiles(raw) : undefined;
      if (profiles) return { profiles, state: 'resolved' };
      if (this.isAbsentSetting(DEVICE_CONTROL_PROFILES, raw)) return { profiles: {}, state: 'resolved' };
    } catch { /* Keep the accepted legacy configuration while the read is unavailable. */ }
    return current;
  }

  private readTargetPowerConfigs(): DeviceTargetPowerConfigsRead {
    const current = this.maps.targetPowerConfigs;
    try {
      const raw = this.settings.get(DEVICE_TARGET_POWER_CONFIGS);
      const configSetting = parseRecordSetting(raw);
      if (!configSetting) {
        return this.isAbsentSetting(DEVICE_TARGET_POWER_CONFIGS, raw)
          ? { configs: {}, authoredDeviceIds: new Set(), state: 'resolved' } : current;
      }
      const configs = normalizeDeviceTargetPowerConfigs(configSetting);
      const authoredDeviceIds = new Set(Object.keys(configSetting).map((id) => id.trim()).filter(Boolean));
      const reachabilityByDevice = normalizeCompleteTargetPowerReachabilityByDevice(
        this.settings.get(DEVICE_TARGET_POWER_REACHABILITY),
      ) ?? {};
      const currentReachabilityByDevice = Object.fromEntries(
        Object.entries(current.configs).flatMap(([deviceId, config]) => (
          config.reachability ? [[deviceId, config.reachability]] : []
        )),
      );
      return { configs: joinTargetPowerReachability(
        configs, reachabilityByDevice, currentReachabilityByDevice,
      ), authoredDeviceIds, state: 'resolved' };
    } catch { /* Keep the accepted legacy configuration while the read is unavailable. */ }
    return current;
  }
}

function joinTargetPowerReachability(
  configs: DeviceTargetPowerConfigsWithReachability,
  reachabilityByDevice: Record<string, TargetPowerReachabilityState>,
  currentReachabilityByDevice: Record<string, TargetPowerReachabilityState>,
): DeviceTargetPowerConfigsWithReachability {
  return Object.fromEntries(Object.entries(configs).map(([deviceId, config]) => {
    const reachability = currentReachabilityByDevice[deviceId] ?? reachabilityByDevice[deviceId];
    if (!reachability) return [deviceId, config];
    const joined = { ...config, reachability };
    return resolveValidTargetPowerReachability(joined)
      ? [deviceId, joined]
      : [deviceId, config];
  }));
}

function parseRecordSetting(value: unknown): Record<string, unknown> | undefined {
  if (isPlainObjectRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isPlainObjectRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeStringMap(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const normalizedKey = key.trim();
      const normalizedEntry = entry.trim();
      return normalizedKey && normalizedEntry ? [[normalizedKey, normalizedEntry]] : [];
    }),
  );
}
