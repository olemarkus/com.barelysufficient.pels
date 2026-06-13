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
import type { BinaryControlCapabilityId, EvChargingState } from '../../contracts/src/types.js';
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
export const isEvSessionInactive = (evChargingState?: EvChargingState): boolean => (
  evChargingState === 'plugged_out' || evChargingState === 'plugged_in_discharging'
);

/**
 * Device-shaped form of {@link isEvSessionInactive} so EV-scoped consumers read
 * the producer-resolved flat bit off the device instead of touching the raw
 * `evChargingState` string themselves (the bug-magnet this de-couple removes:
 * consumers must never re-derive plug-state semantics). The flat bit is
 * materialized at the producer seam (`resolveCommandableNow` → `toPlanDevice`)
 * and is absent (→ `false`) for non-EV devices. Caller scopes EV-ness.
 */
export const isEvSessionInactiveForDevice = (dev: EvStateConsumerInput): boolean => (
  dev.evSessionInactive ?? false
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
export const isEvChargerNotResumable = (evChargingState?: EvChargingState): boolean => (
  evChargingState === 'plugged_in'
);

/**
 * Device-shaped form of {@link isEvChargerNotResumable}. Reads the
 * producer-resolved flat bit (absent → `false` for non-EV). Caller scopes
 * EV-ness.
 */
export const isEvChargerNotResumableForDevice = (dev: EvStateConsumerInput): boolean => (
  dev.evChargerNotResumable ?? false
);

/**
 * Whether the EV plug-state blocks boost activation: every state PELS cannot
 * drive toward a target — unplugged / discharging (no creditable session) OR
 * `plugged_in` (connected but NOT resumable). The runtime boost-active gate
 * (`resolveEvBoostActive`) reads this; the settings-UI boost panel renders the
 * matching reason STRING via `resolveEvBoostBlockReason`. Both decide on the
 * same plug-state set so the runtime never forces boost the UI says won't
 * activate. Caller scopes EV-ness.
 */
export const isEvBoostBlockedByPlugState = (dev: EvStateConsumerInput): boolean => (
  isEvSessionInactiveForDevice(dev) || isEvChargerNotResumableForDevice(dev)
);

/**
 * Consumer input for the device-shaped EV resolvers. Single-shaped: every call
 * site passes the producer-resolved flat bits (`evSessionInactive` /
 * `evChargerNotResumable`), materialized once at the producer seam
 * (`resolveCommandableNow` → `toPlanDevice`). Both are absent for a non-EV
 * device, so the resolvers default to `false`. The raw `evChargingState` arm
 * that used to back snapshot-shaped callers is retired: the only sanctioned
 * reader of the raw plug-state is the producer itself
 * ({@link resolveCommandableNow}), which materializes these bits.
 */
export type EvStateConsumerInput = {
  evSessionInactive?: boolean;
  evChargerNotResumable?: boolean;
};

export type CommandableNowResolveInput = {
  deviceClass?: string;
  controlCapabilityId?: BinaryControlCapabilityId;
  evChargingState?: EvChargingState;
  evSessionInactive?: boolean;
  evChargerNotResumable?: boolean;
  evBlockReason?: string | null;
  available?: boolean;
};

export type CommandableNowResolution = {
  commandableNow: boolean;
  reason: string | null;
  // EV plug-state sub-classification — both false / null for non-EV or commandable EV.
  evBlockReason: string | null;      // EV-plug-specific block reason (independent of 'device unavailable')
  evSessionInactive: boolean;        // plugged_out / plugged_in_discharging
  evChargerNotResumable: boolean;    // plugged_in
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

  // EV plug-state sub-classification, materialized here at the producer seam
  // from the raw `evChargingState` via the GATELESS plug-state primitives
  // (`resolveEvBlockReason` / `isEvSessionInactive` / `isEvChargerNotResumable`),
  // each scoped to `isEvDevice` so the contract holds — `false`/`null` for
  // non-EV — even if a non-EV device unexpectedly carries an `evChargingState`.
  // This is the ONE place the raw plug-state is read; downstream consumers read
  // the flat bits below through the device-shaped resolvers (no raw arm).
  const isEv = isEvDevice(dev);
  const evBlock = isEv ? resolveEvBlockReason(dev.evChargingState) : null;
  const evSub = {
    evBlockReason: evBlock,
    evSessionInactive: isEv && isEvSessionInactive(dev.evChargingState),
    evChargerNotResumable: isEv && isEvChargerNotResumable(dev.evChargingState),
  };

  if (evBlock !== null) {
    return { commandableNow: false, reason: evBlock, ...evSub };
  }

  if (dev.available === false) {
    return { commandableNow: false, reason: 'device unavailable', ...evSub };
  }

  return { commandableNow: true, reason: null, ...evSub };
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
 * EV block-reason for a device: `null` when commandable (or not an EV), else the
 * reason string. The device-shaped public resolver consumed by the plan
 * restore-reason gate (`getEvRestoreStateBlockReason`), which therefore never
 * re-derives the EV-state switch nor touches the raw `evChargingState`.
 *
 * Reads ONLY the producer-resolved flat `evBlockReason`, materialized once at
 * the producer seam (`resolveCommandableNow` → `toPlanDevice`) where it is
 * already EV-scoped behind `isEvDevice` and stays EV-specific (`null` for a
 * commandable EV, never the general 'device unavailable'; `state_unknown` for an
 * EV with no trusted plug-state). Non-EV devices carry no flat field → `null`.
 *
 * Single materialized input: there is no raw-state read after any gate, so the
 * historical "short-circuit before the `isEvDevice` gate" footgun cannot exist —
 * a hand-constructed input can only set `evBlockReason`, which is exactly the
 * producer-scoped value, never a raw plug-state the gate would have to filter.
 */
export function resolveEvBlockReasonForDevice(dev: { evBlockReason?: string | null }): string | null {
  return dev.evBlockReason ?? null;
}
