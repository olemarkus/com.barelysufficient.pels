import {
  isShedBehaviorsSetting, readShedBehaviors, resolveShedBehavior,
  type ConfiguredShedBehavior,
} from '../../packages/shared-domain/src/settings/shedBehaviors';
import { getLogger } from '../logging/logger';
import type { DeviceJournal } from '../ports/deviceJournal';
import type { SettingsPort } from '../ports/homeyRuntime';
import { isBooleanMap } from '../utils/appTypeGuards';
import { readSettingsKeyList } from '../utils/settingsKeyList';
import { CONTROLLABLE_DEVICES, OVERSHOOT_BEHAVIORS } from '../utils/settingsKeys';

type PowerLimitMaps = {
  controllable?: Readonly<Record<string, boolean>>;
  shedBehaviors?: Readonly<Record<string, ConfiguredShedBehavior>>;
};

const EMPTY_MAP = {};
const logger = getLogger('device/power-limit-settings');

function sameBehavior(left: ConfiguredShedBehavior, right: ConfiguredShedBehavior): boolean {
  if (left.action !== 'set_temperature') return left.action === right.action;
  return right.action === 'set_temperature'
    && left.temperature === right.temperature && left.coolingTemperature === right.coolingTemperature;
}

function settingsForDevice(maps: PowerLimitMaps, deviceId: string) {
  return {
    ...(maps.controllable ? { powerLimitControl: maps.controllable[deviceId] === true } : {}),
    ...(maps.shedBehaviors ? { configuredShedBehavior: resolveShedBehavior(maps.shedBehaviors, deviceId) } : {}),
  };
}

/** Owns the accepted settings and records changes independently of actuation. */
export class DevicePowerLimitSettings {
  private accepted: PowerLimitMaps = {};

  constructor(
    private readonly settings: Pick<SettingsPort, 'get' | 'getKeys'>,
    private readonly journal: DeviceJournal,
  ) {}

  get controllable(): Readonly<Record<string, boolean>> { return this.accepted.controllable ?? EMPTY_MAP; }

  shedBehavior(deviceId: string): ConfiguredShedBehavior {
    return resolveShedBehavior(this.accepted.shedBehaviors ?? EMPTY_MAP, deviceId);
  }

  /** Stage the maps. The containing settings owner adopts only after the full read succeeds. */
  read(): PowerLimitMaps {
    const rawControl = this.settings.get(CONTROLLABLE_DEVICES);
    const rawBehavior = this.settings.get(OVERSHOOT_BEHAVIORS);
    const controllable = isBooleanMap(rawControl) ? { ...rawControl } : this.accepted.controllable;
    const shedBehaviors = isShedBehaviorsSetting(rawBehavior)
      ? readShedBehaviors(rawBehavior) : this.accepted.shedBehaviors;
    // At boot, a proven unset key is a verified default, not an unread choice.
    const controlNeedsBaseline = controllable === undefined && rawControl == null;
    const behaviorNeedsBaseline = shedBehaviors === undefined && rawBehavior == null;
    if (!controlNeedsBaseline && !behaviorNeedsBaseline) return { controllable, shedBehaviors };
    const keys = readSettingsKeyList(this.settings);
    if (keys.status !== 'resolved') return { controllable, shedBehaviors };
    return {
      controllable: controlNeedsBaseline && !keys.keys.includes(CONTROLLABLE_DEVICES) ? EMPTY_MAP : controllable,
      shedBehaviors: behaviorNeedsBaseline && !keys.keys.includes(OVERSHOOT_BEHAVIORS) ? EMPTY_MAP : shedBehaviors,
    };
  }

  adopt(next: PowerLimitMaps): void {
    const previous = this.accepted;
    this.accepted = next;
    const ids = new Set([
      ...comparableIds(previous.controllable, next.controllable),
      ...comparableIds(previous.shedBehaviors, next.shedBehaviors),
    ]);
    for (const deviceId of ids) {
      const before = settingsForDevice(previous, deviceId);
      const after = settingsForDevice(next, deviceId);
      if (!hasChanged(before, after)) continue;
      const event = {
        component: 'devices',
        event: 'device_power_limit_settings_changed',
        deviceId,
        previous: before,
        current: after,
      };
      logger.info(event);
      this.journal.record([deviceId], event);
    }
  }
}

function comparableIds<T>(
  before: Readonly<Record<string, T>> | undefined,
  after: Readonly<Record<string, T>> | undefined,
): string[] {
  return before && after && before !== after ? [...Object.keys(before), ...Object.keys(after)] : [];
}

function hasChanged(
  before: ReturnType<typeof settingsForDevice>,
  after: ReturnType<typeof settingsForDevice>,
): boolean {
  if (before.powerLimitControl !== undefined && after.powerLimitControl !== before.powerLimitControl) return true;
  return before.configuredShedBehavior !== undefined && after.configuredShedBehavior !== undefined
    && !sameBehavior(before.configuredShedBehavior, after.configuredShedBehavior);
}
