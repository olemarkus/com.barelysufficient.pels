/**
 * Canonical home for the EV-charger reason strings surfaced when a device
 * is not commandable in the current cycle.
 *
 * Three runtime producers emit these strings today:
 *
 *  - `lib/device/deviceActionProjection.ts:resolveCommandableNow`
 *    (the new producer-seam home, fed onto `commandableNowReason`)
 *  - `lib/device/deviceActionProjection.ts:getEvRestoreBlockReason`
 *    (legacy snapshot-shape helper for the binary-control planner)
 *  - `lib/plan/restore/devices.ts:getEvRestoreStateBlockReason`
 *    (legacy restore-eligibility gate, surfaced via `DeviceReason.detail`)
 *
 * Both routes feed UI surfaces (status chips, device cards, plan reason
 * detail text), so per `feedback_ui_text_shared_with_logs` the literals
 * live in `packages/shared-domain/**` and both producers import from one
 * source. The strings are byte-for-byte identical to the prior inline
 * literals — no user-visible change.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

import type { EvChargingState, EvObservedFields } from '../../contracts/src/types';

/**
 * Discriminator for the two EV plug-states that block actuation. Both are
 * states where the electrics say no: there is no car to charge (`plugged_out`)
 * or the session is exporting (`plugged_in_discharging`).
 *
 * Every other plug-state — including `plugged_in` and an absent/unrecognised
 * one — is commandable and has no entry here. See {@link resolveEvBlockReasonKey}
 * for why.
 */
export type EvCommandableNowReasonKey =
  | 'plugged_out'
  | 'plugged_in_discharging';

export const EV_COMMANDABLE_NOW_REASONS: Record<EvCommandableNowReasonKey, string> = {
  plugged_out: 'charger is unplugged',
  plugged_in_discharging: 'charger is discharging',
};

/**
 * THE EV plug-state switch — the single place any layer decides whether the
 * plug-state blocks PELS from driving the charger. Returns the block key, or
 * `null` when nothing about the plug-state stands in the way.
 *
 * Everything keyed off EV plug-state derives from this one function: the
 * commandability reason ({@link resolveEvBlockReason}, materialized onto
 * `evBlockReason` by `resolveCommandableNow`) and the boost-panel copy
 * ({@link resolveEvBoostBlockReason}). There is deliberately no second switch —
 * the two vocabularies differ, the classification must not.
 *
 * **Only `plugged_out` and `plugged_in_discharging` block.** `plugged_in` does
 * NOT, and that is the point: the value is vendor-defined and inconsistent
 * across Homey apps. Easee maps "Awaiting Authentication" and "Ready to Charge"
 * to it (a start command is exactly what those want); Wallbox maps its `Paused`
 * state to it and never emits `plugged_in_paused` at all — so treating it as a
 * block let PELS's own pause create a state PELS then refused to leave. go-e is
 * the lone app using it for a finished session, where a start command is merely
 * a no-op. Commandability is not knowable from this literal; PELS learns it by
 * commanding and watching (`lib/plan/admission/activationBackoff.ts`).
 *
 * Takes a REQUIRED `EvChargingState`: an absent plug-state is unrepresentable
 * here, the same way `EvObservedFields` makes it unrepresentable downstream.
 * Absence is resolved once at the capability read (`getEvChargingState` yields
 * no value, so the snapshot simply carries no `evChargingState`) and means
 * "there is no such signal — skip", exactly like a device with no `onoff`
 * capability. It is not a fifth plug-state to classify: it collapses a
 * permanently-absent capability, a vendor value outside the Homey enum, a cold
 * start, and a transient observation gap, so nothing principled can be decided
 * from it. Callers narrow (`isEvObserved`) and do nothing when absent.
 */
export const resolveEvBlockReasonKey = (
  evChargingState: EvChargingState,
): EvCommandableNowReasonKey | null => {
  switch (evChargingState) {
    case 'plugged_out':
      return 'plugged_out';
    case 'plugged_in_discharging':
      return 'plugged_in_discharging';
    case 'plugged_in':
    case 'plugged_in_paused':
    case 'plugged_in_charging':
      return null;
    default: {
      // Exhaustiveness guard: a new EvChargingState member must be classified
      // above rather than silently inheriting the commandable default.
      const exhaustive: never = evChargingState;
      void exhaustive;
      return null;
    }
  }
};

/**
 * Commandability reason string, GATELESS (the caller applies its own EV-device
 * gate). Consumed by:
 *   - `resolveCommandableNow` (`commandableNow.ts`)
 *   - `getEvRestoreBlockReason` (`lib/device/deviceActionProjection.ts`, snapshot-shaped)
 *   - `getEvRestoreStateBlockReason` (`lib/plan/restore/devices.ts`, plan-device-shaped)
 *
 * Pure copy lookup over {@link resolveEvBlockReasonKey} — no classification here.
 * Requires an observed plug-state for the same reason the key resolver does.
 */
export const resolveEvBlockReason = (evChargingState: EvChargingState): string | null => {
  const key = resolveEvBlockReasonKey(evChargingState);
  return key === null ? null : EV_COMMANDABLE_NOW_REASONS[key];
};

/**
 * EV-boost-context status strings for EV-state cases that block boost
 * activation. Read by the settings-UI boost panel
 * (`packages/settings-ui/src/ui/deviceDetail/evBoost.ts`) — co-located here
 * with the other EV-state-keyed reason strings so both vocabularies live in
 * one browser-safe home, per `feedback_ui_text_shared_with_logs`.
 *
 * Keyed by {@link EvCommandableNowReasonKey} — the boost panel blocks on exactly
 * the states that block actuation, because "boost" is just "command it on now".
 * Same classification, different vocabulary: these strings speak to the owner
 * looking at the boost panel, the `EV_COMMANDABLE_NOW_REASONS` ones appear in
 * plan reason detail and logs.
 */
export const EV_BOOST_BLOCK_REASONS: Record<EvCommandableNowReasonKey, string> = {
  plugged_out: 'Car not connected. Boost will not activate.',
  plugged_in_discharging: 'Car is discharging. Boost will not activate.',
};

/**
 * Device-shaped resolver for the boost-block reason so the settings-UI boost
 * panel reads it off the device instead of inlining the plug-state literals
 * (the bug-magnet this de-couple removes). Returns the block-reason string when
 * the plug-state blocks, else `null` (fall through to the battery-level checks).
 *
 * Classification comes from {@link resolveEvBlockReasonKey}; this only picks the
 * boost-panel wording. Takes the NARROWED `EvObservedFields` shape: the caller
 * decides plug-state presence exactly once, at the `isEvObserved` guard.
 */
export const resolveEvBoostBlockReason = (dev: EvObservedFields): string | null => {
  const key = resolveEvBlockReasonKey(dev.evChargingState);
  return key === null ? null : EV_BOOST_BLOCK_REASONS[key];
};
