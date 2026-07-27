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
 * The bare connected state (`plugged_in` — distinct from `plugged_in_paused` /
 * `plugged_in_charging`): the car is plugged in and the charger is reporting no
 * active session. PELS still commands a charger in this state — the literal is
 * too vendor-inconsistent to gate actuation on (see `resolveEvBlockReasonKey`) —
 * but it is NOT evidence that charge is flowing, so the SoC behind it must not
 * be credited as on-track objective progress until the state moves to
 * `plugged_in_charging`.
 *
 * Actuation and progress-crediting are separate questions; this predicate
 * answers only the second. Its sole consumer is
 * `lib/objectives/deferredObjectives/diagnosticProgress.ts`. Co-located with
 * {@link isEvSessionInactive} for the same vocabulary-containment reason.
 * Caller scopes EV-ness.
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
 * Whether the EV plug-state blocks boost activation. Boost is "command it on
 * now", so this is not a second question — it is exactly `not commandable`,
 * read off the producer-resolved `evBlockReason`. The runtime boost-active gate
 * (`resolveEvBoostActive`) reads this; the settings-UI boost panel renders the
 * matching reason STRING via `resolveEvBoostBlockReason`, keyed off the same
 * `resolveEvBlockReasonKey` classification. One switch decides for both, so the
 * runtime can never force boost the UI says won't activate — and the two cannot
 * drift apart the way a separately-composed predicate did.
 * Caller scopes EV-ness.
 */
export const isEvBoostBlockedByPlugState = (dev: { evBlockReason?: string | null }): boolean => (
  resolveEvBlockReasonForDevice(dev) !== null
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

/**
 * Consumer input: the producer-resolved bits ONLY. There is deliberately no raw
 * `evChargingState` arm here — a consumer that could fall back to re-resolving
 * would be answering from whatever fields happen to be present, which is how
 * `isCommandableNow` came to report `false` for every plan device (the raw state
 * is stripped by `withEvDiscriminant`, so the fallback saw absence and called it
 * "charger state unknown"). Absence must not be interpretable: `commandableNow`
 * is required on every carrier that reaches a consumer.
 */
export type CommandableNowConsumerInput = {
  commandableNow: boolean;
  commandableNowReason?: string | null;
};

/**
 * Resolve whether the device is commandable: can the controller issue a control
 * command to it this cycle and expect it to land and matter. Pure function of
 * the consolidated observed truth — no grace window.
 *
 * Returns:
 *   - `commandableNow: false` with a reason string when actuation is impossible
 *     (EV unplugged / discharging, or the device is unavailable).
 *   - `commandableNow: true` with `reason: null` when the device accepts
 *     commands.
 *
 * An EV device with no resolved plug-state is commandable. `undefined` is not a
 * device state: it collapses a permanently-absent `evcharger_charging_state`
 * capability (a `car`-class device driven through `evcharger_charging` never has
 * one), a vendor value outside the Homey enum, a cold start, and the narrow
 * window where the live feed is down AND a pull omits the capability with no
 * retained observation. Failing closed on that looked like safety but was a
 * permanent block for the first two, so the gate now fails OPEN and the command
 * outcome decides: `activationBackoff` penalises a device commanded on that
 * never draws. Commanding an unplugged charger is a no-op, not a hazard.
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
  // `evBlockReason` and `evSessionInactive` classify the same two states today
  // (`resolveEvBlockReasonKey` blocks exactly what `isEvSessionInactive` marks);
  // they stay separate fields because they answer different questions — may we
  // command it, and is there a creditable session — and a future plug-state
  // could separate them again.
  // Absence is resolved HERE, at the seam nearest the capability read, and means
  // "no such signal — skip", never a classified state. `resolveEvBlockReason`
  // therefore takes a required `EvChargingState` and has no `undefined` arm to
  // misread. Same discipline as a device with no `onoff` capability: nothing is
  // inferred from the missing signal.
  const isEv = isEvDevice(dev);
  const evBlock = isEv && dev.evChargingState !== undefined
    ? resolveEvBlockReason(dev.evChargingState)
    : null;
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
 * Consumer read of the producer-resolved bit. NOT a dual-read: the fallback that
 * re-resolved from raw fields is gone, because it answered from whichever fields
 * a carrier happened to have. On a `DevicePlanDevice` — where `withEvDiscriminant`
 * strips `evChargingState` — that fallback saw absence and reported "charger
 * state unknown" for every EV charger, which is why `hasStableBinaryReleaseActuation`
 * was dead in production (TODO 2026-07-25). Callers that hold a raw snapshot
 * instead of a resolved carrier call {@link resolveCommandableNow} explicitly.
 */
export function isCommandableNow(dev: CommandableNowConsumerInput): boolean {
  return dev.commandableNow;
}

/** @public — intentionally retained (was in check-dead-code parked list). */
export function getCommandableNowReason(dev: CommandableNowConsumerInput): string | null {
  return dev.commandableNowReason ?? null;
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
