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
import type { BinaryControlCapabilityId } from '../../contracts/src/types.js';
import { resolveEvBlockReason } from './commandableNowReason';

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

/**
 * The two EV charging states that mean there is no live, creditable charging
 * session: the car is unplugged (`plugged_out`), or it is exporting power back
 * (`plugged_in_discharging`). In both, the charger cannot be driven toward a
 * SoC target and its state-of-charge cannot be credited as progress.
 *
 * Co-located here (browser-safe, next to `isEvDevice` and the EV reason
 * strings) so plan/objectives consumers read this resolved predicate instead of
 * inlining the Homey plug-state literals — the same vocabulary-containment goal
 * as `EV_COMMANDABLE_NOW_REASONS`. Does NOT itself gate on `isEvDevice`: callers
 * that are already EV-scoped (e.g. the `ev_soc` progress reader) pass the state
 * directly; callers that aren't compose it with `isEvDevice` themselves.
 */
export const isEvSessionInactive = (evChargingState?: string | null): boolean => (
  evChargingState === 'plugged_out' || evChargingState === 'plugged_in_discharging'
);

/**
 * Device-shaped form of {@link isEvSessionInactive} so EV-scoped consumers read
 * the resolved predicate off the device instead of touching the raw
 * `evChargingState` string themselves (the bug-magnet this de-couple removes:
 * consumers must never re-derive plug-state semantics). Caller scopes EV-ness.
 */
export const isEvSessionInactiveForDevice = (dev: { evChargingState?: string | null }): boolean => (
  isEvSessionInactive(dev.evChargingState)
);

/**
 * The connected-but-NOT-resumable EV state: the car is plugged in but the
 * charging session cannot be driven back on by a command (`plugged_in` —
 * distinct from the resumable `plugged_in_paused`). PELS cannot move this
 * charger toward its SoC target, so its SoC must not be credited as on-track
 * progress and boost / objective surfaces must say so rather than reading as
 * healthy. Co-located with {@link isEvSessionInactive} for the same
 * vocabulary-containment reason — consumers read this resolved predicate
 * instead of inlining the plug-state literal. Caller scopes EV-ness.
 */
export const isEvChargerNotResumable = (evChargingState?: string | null): boolean => (
  evChargingState === 'plugged_in'
);

/** Device-shaped form of {@link isEvChargerNotResumable}. Caller scopes EV-ness. */
export const isEvChargerNotResumableForDevice = (dev: { evChargingState?: string | null }): boolean => (
  isEvChargerNotResumable(dev.evChargingState)
);

export type CommandableNowResolveInput = {
  deviceClass?: string;
  controlCapabilityId?: BinaryControlCapabilityId;
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

  const evBlock = resolveDeviceStateBlockReason(dev);
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

/**
 * Device-state block-reason for a device: `null` when commandable (or not an EV), else the
 * reason string. The device-shaped public resolver shared by `resolveCommandableNow`
 * AND the plan restore-reason gate, so neither re-derives the EV-state switch nor
 * touches the raw `evChargingState`. Gates EV-ness itself (the gateless switch is
 * `resolveEvBlockReason` in commandableNowReason). `undefined` → state_unknown: no
 * trusted plug-state (genuine cold start; transport's consolidated truth would
 * otherwise preserve a real value).
 */
export function resolveDeviceStateBlockReason(dev: CommandableNowResolveInput): string | null {
  if (!isEvDevice(dev)) return null;
  return resolveEvBlockReason(dev.evChargingState);
}
