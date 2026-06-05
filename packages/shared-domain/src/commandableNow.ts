/**
 * Pure commandability resolution, shared across layers.
 *
 * Lives in `packages/shared-domain` (not `lib/device`) so every layer that needs
 * the answer can import it legally: the device producer, the planner, AND the
 * executor (`lib/executor` may not import `lib/device` internals — the
 * `no-executor-to-device-internals` cruiser rule). The function is a pure,
 * browser-safe projection of already-resolved observed fields; the reason
 * strings it returns live alongside it in `commandableNowReason.ts`.
 */
import {
  EV_COMMANDABLE_NOW_REASONS,
  formatUnknownEvChargingStateReason,
} from './commandableNowReason';

/**
 * EV-device predicate. A device is "EV" if EITHER its `deviceClass` is
 * `'evcharger'` OR its resolved binary control capability is
 * `'evcharger_charging'`. Real EV devices set both; the union collapses the two
 * historical gates into one source of truth. Returns `false` when both are
 * missing.
 */
export const isEvDevice = (dev: { deviceClass?: string; controlCapabilityId?: string }): boolean => (
  dev.deviceClass === 'evcharger' || dev.controlCapabilityId === 'evcharger_charging'
);

export type CommandableNowResolveInput = {
  deviceClass?: string;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  evChargingState?: string;
  available?: boolean;
};

export type CommandableNowResolution = {
  commandableNow: boolean;
  reason: string | null;
};

export type CommandableNowConsumerInput = CommandableNowResolveInput & {
  commandableNow?: boolean;
  commandableNowReason?: string | null;
};

/**
 * Resolve whether the device is commandable: can the controller issue a control
 * command to it this cycle and expect it to land and matter. Pure function of
 * the consolidated observed truth — no grace window.
 *
 * Returns:
 *   - `commandableNow: false` with a reason string when actuation is impossible
 *     or pointless (EV unplugged / discharging / not-resumable, unavailable, or
 *     no trusted plug-state yet).
 *   - `commandableNow: true` with `reason: null` when the device accepts
 *     commands.
 *
 * No abandon-grace here: PELS device state is push-primary (realtime capability
 * events). While a retained realtime `evcharger_charging_state` observation
 * exists, transport's fresher-wins merge re-applies it
 * (`managerObservation.mergeCapabilityObservation`), so `evChargingState` does
 * not flap to `undefined` on a transient missing pull. `undefined` only reaches
 * here on a genuine cold start (or the narrow window where the live feed is down
 * AND a pull omits the capability with no prior retained observation), and it
 * resolves pessimistically to `{ commandableNow: false, reason: 'charger state
 * unknown' }`. That is the safe direction: the resume gate fails closed, and
 * `currentOn` is independently preserved via previous-snapshot synthesis, so a
 * one-cycle `undefined` never drives a spurious actuation.
 */
export function resolveCommandableNow(params: {
  dev: CommandableNowResolveInput;
}): CommandableNowResolution {
  const { dev } = params;

  const evBlock = resolveEvCommandableBlock(dev);
  if (evBlock !== null) {
    return { commandableNow: false, reason: evBlock };
  }

  if (dev.available === false) {
    return { commandableNow: false, reason: 'device unavailable' };
  }

  return { commandableNow: true, reason: null };
}

/**
 * Dual-read consumer helper: prefer the producer-resolved bit when present
 * (planner call sites pass a `PlanInputDevice`), else resolve from raw fields
 * (executor / snapshot call sites). One shared resolver — consumers never
 * re-implement the policy.
 */
export function isCommandableNow(dev: CommandableNowConsumerInput): boolean {
  if (dev.commandableNow !== undefined) return dev.commandableNow;
  return resolveCommandableNow({ dev }).commandableNow;
}

/** @public — intentionally retained (was in check-dead-code parked list). */
export function getCommandableNowReason(dev: CommandableNowConsumerInput): string | null {
  if (dev.commandableNow !== undefined) return dev.commandableNowReason ?? null;
  return resolveCommandableNow({ dev }).reason;
}

function resolveEvCommandableBlock(dev: CommandableNowResolveInput): string | null {
  if (!isEvDevice(dev)) return null;

  switch (dev.evChargingState) {
    case 'plugged_out':
      return EV_COMMANDABLE_NOW_REASONS.plugged_out;
    case 'plugged_in_discharging':
      return EV_COMMANDABLE_NOW_REASONS.plugged_in_discharging;
    case 'plugged_in':
      return EV_COMMANDABLE_NOW_REASONS.plugged_in;
    case 'plugged_in_paused':
    case 'plugged_in_charging':
      return null;
    case undefined:
      // No trusted plug-state (genuine cold start; transport's consolidated
      // truth would otherwise preserve a real value). Pessimistic: not
      // commandable until a confident read arrives.
      return EV_COMMANDABLE_NOW_REASONS.state_unknown;
    default:
      return formatUnknownEvChargingStateReason(dev.evChargingState);
  }
}
