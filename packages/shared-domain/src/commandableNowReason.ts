/**
 * Canonical home for the EV-charger reason strings surfaced when a device
 * is not commandable in the current cycle.
 *
 * Runtime producers emit these strings through:
 *
 *  - `lib/device/deviceActionProjection.ts:resolveCommandableNow`
 *    (the new producer-seam home, fed onto `commandableNowReason`)
 *  - `lib/device/deviceActionProjection.ts:getEvRestoreBlockReason`
 *    (legacy snapshot-shape helper for the binary-control planner)
 *
 * Both routes feed UI surfaces (status chips, device cards, plan reason
 * detail text), so per `feedback_ui_text_shared_with_logs` the literals
 * live in `packages/shared-domain/**` and both producers import from one
 * source. The strings are byte-for-byte identical to the prior inline
 * literals — no user-visible change.
 *
 * Browser-safe: no Homey SDK types, no runtime imports.
 */

import type { EvChargingState } from '../../contracts/src/types';

/**
 * Discriminator for EV state that blocks actuation: no car, discharging, or no
 * affirmative state evidence. Connected idle/paused states remain probeable.
 */
export type EvCommandableNowReasonKey =
  | 'state_unknown'
  | 'plugged_out'
  | 'plugged_in_discharging';

export const EV_COMMANDABLE_NOW_REASONS: Record<EvCommandableNowReasonKey, string> = {
  state_unknown: 'charger state is unknown',
  plugged_out: 'charger is unplugged',
  plugged_in_discharging: 'charger is discharging',
};
export const EV_RESUME_PROBE_FAILED_REASON = 'charging did not start';

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
 * `plugged_out`, `plugged_in_discharging`, and an absent/unrecognised state block. `plugged_in` does
 * NOT, and that is the point: the value is vendor-defined and inconsistent
 * across Homey apps. Easee maps "Awaiting Authentication" and "Ready to Charge"
 * to it (a start command is exactly what those want); Wallbox maps its `Paused`
 * state to it and never emits `plugged_in_paused` at all — so treating it as a
 * block let PELS's own pause create a state PELS then refused to leave. go-e and
 * Zaptec also use it for a finished session, where a start command is a no-op.
 * PELS probes that connected
 * state and backs off when the charger does
 * not start; it never probes without affirmative connected evidence.
 *
 * Absence collapses several outside states (cold start, unreadable capability,
 * or an unrecognised vendor value), none of which is permission to issue a
 * load-adding command. It therefore fails closed here.
 */
export const resolveEvBlockReasonKey = (
  evChargingState: EvChargingState | undefined,
): EvCommandableNowReasonKey | null => {
  switch (evChargingState) {
    case undefined:
      return 'state_unknown';
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
 *
 * Pure copy lookup over {@link resolveEvBlockReasonKey} — no classification here.
 */
export const resolveEvBlockReason = (evChargingState: EvChargingState | undefined): string | null => {
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
  state_unknown: 'Charger state is unavailable. Boost will not activate.',
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
 * boost-panel wording. Missing state is deliberately accepted here and maps to
 * the unavailable-state reason, matching the runtime's fail-closed behavior.
 */
export const resolveEvBoostBlockReason = (dev: { evChargingState?: EvChargingState }): string | null => {
  const key = resolveEvBlockReasonKey(dev.evChargingState);
  return key === null ? null : EV_BOOST_BLOCK_REASONS[key];
};
