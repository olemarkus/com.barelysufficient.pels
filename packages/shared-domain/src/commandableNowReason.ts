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

/**
 * Discriminator for the non-commandable EV states that produce a reason
 * string. `plugged_in_paused` / `plugged_in_charging` are commandable and
 * have no entry here.
 */
export type EvCommandableNowReasonKey =
  | 'plugged_out'
  | 'plugged_in'
  | 'plugged_in_discharging'
  | 'state_unknown';

export const EV_COMMANDABLE_NOW_REASONS: Record<EvCommandableNowReasonKey, string> = {
  plugged_out: 'charger is unplugged',
  plugged_in: 'charger is not resumable',
  plugged_in_discharging: 'charger is discharging',
  state_unknown: 'charger state unknown',
};

/**
 * Reason for an EV state value that is neither one of the well-known
 * commandable states nor one of the recognised non-commandable ones.
 * Used by both producer call sites when the SDK reports an unknown
 * `evChargingState` string.
 */
export const formatUnknownEvChargingStateReason = (state: string): string => (
  `unknown charging state '${state}'`
);
