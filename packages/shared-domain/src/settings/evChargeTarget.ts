import type {
  EvChargeTargetConfig, EvChargeTargetSetting, EvChargeTargetSettings,
} from '../../../contracts/src/types';
import { isUnknownRecord } from '../recordGuards';

/**
 * Owner of `ev_charge_target_settings`, read by the runtime (the planner's charge
 * target hold) and written by the settings UI's charger page.
 *
 * Read policy: sanitize and keep, per entry. An entry whose target is not a
 * whole percent in 1..100 may keep an explicit disabled preference. Other
 * invalid entries are dropped. On an active target, a `chargeBeforeLevelKnown`
 * that is not a boolean reads as `true`,
 * which is the default and the behaviour the charger had before it had a target:
 * charge until the car stops. The settings UI writes only typed values it
 * built from a parsed target (`parseEvChargeTargetPercent`).
 */

const MIN_TARGET_PERCENT = 1;
const MAX_TARGET_PERCENT = 100;

/** A target the owner may store: a finite whole percent in 1..100. */
export const isEvChargeTargetPercent = (value: unknown): value is number => (
  typeof value === 'number'
  && Number.isInteger(value)
  && value >= MIN_TARGET_PERCENT
  && value <= MAX_TARGET_PERCENT
);

/**
 * A stored or typed target, rounded to a whole percent, or `null` when it is no
 * usable target (blank, not a number, or outside 1..100). The settings UI's
 * field reads through this too, so a cleared field never saves a target.
 */
export const parseEvChargeTargetPercent = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return isEvChargeTargetPercent(rounded) ? rounded : null;
};

export const normalizeEvChargeTargetSettings = (value: unknown): EvChargeTargetSettings => {
  if (!isUnknownRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([deviceId, entry]): Array<[string, EvChargeTargetSetting]> => {
      if (!isUnknownRecord(entry)) return [];
      const targetPercent = parseEvChargeTargetPercent(entry.targetPercent);
      if (targetPercent !== null) {
        return [[deviceId, { targetPercent, chargeBeforeLevelKnown: entry.chargeBeforeLevelKnown !== false }]];
      }
      if (entry.disabled === true && typeof entry.chargeBeforeLevelKnown === 'boolean') {
        return [[deviceId, { disabled: true, chargeBeforeLevelKnown: entry.chargeBeforeLevelKnown }]];
      }
      return [];
    }),
  );
};

export const resolveActiveEvChargeTarget = (
  setting: EvChargeTargetSetting | undefined,
): EvChargeTargetConfig | undefined => (
  setting && 'targetPercent' in setting ? setting : undefined
);
