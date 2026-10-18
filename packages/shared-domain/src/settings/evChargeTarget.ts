import type { EvChargeTargetConfig, EvChargeTargetSettings } from '../../../contracts/src/types';

/**
 * Owner of `ev_charge_target_settings`, read by the runtime (the planner's charge
 * target hold) and written by the settings UI's charger page.
 *
 * Read policy: sanitize and keep, per entry. An entry whose target is not a
 * whole percent in 1..100 is dropped (no target), because no hold can be decided
 * from it. A `chargeBeforeLevelKnown` that is not a boolean reads as `true`,
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([deviceId, entry]) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const config = entry as Record<string, unknown>;
      const targetPercent = parseEvChargeTargetPercent(config.targetPercent);
      if (targetPercent === null) return [];
      const normalized: EvChargeTargetConfig = {
        targetPercent,
        chargeBeforeLevelKnown: config.chargeBeforeLevelKnown !== false,
      };
      return [[deviceId, normalized]];
    }),
  );
};
