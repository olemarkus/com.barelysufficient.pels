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

import type { EvChargingState } from '../../contracts/src/types';

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
 * The EV-state → block-reason switch, GATELESS (the caller applies its own
 * EV-device gate). Single source of truth for the three byte-identical
 * EV-block-reason consumers that used to inline this switch:
 *   - `resolveCommandableNow` (`commandableNow.ts`)
 *   - `getEvRestoreBlockReason` (`lib/device/deviceActionProjection.ts`, snapshot-shaped)
 *   - `getEvRestoreStateBlockReason` (`lib/plan/restore/devices.ts`, plan-device-shaped)
 *
 * Returns `null` for the commandable states (`plugged_in_paused` /
 * `plugged_in_charging`), the reason string for the non-commandable ones, and
 * `state_unknown` for `undefined`. `undefined` covers both a genuine cold start
 * (no trusted plug-state yet) and a vendor value outside the capability enum:
 * the producer (`getEvChargingState`) normalises any unrecognised value to
 * `undefined`, so such a charger is simply uncommandable here — the raw value is
 * never surfaced.
 */
export const resolveEvBlockReason = (evChargingState: EvChargingState | undefined): string | null => {
  switch (evChargingState) {
    case 'plugged_in_paused':
    case 'plugged_in_charging':
      return null;
    case 'plugged_in':
      return EV_COMMANDABLE_NOW_REASONS.plugged_in;
    case 'plugged_out':
      return EV_COMMANDABLE_NOW_REASONS.plugged_out;
    case 'plugged_in_discharging':
      return EV_COMMANDABLE_NOW_REASONS.plugged_in_discharging;
    case undefined:
      return EV_COMMANDABLE_NOW_REASONS.state_unknown;
    default: {
      // Exhaustiveness guard: a new EvChargingState member must be classified
      // above rather than silently treated as the unknown/uncommandable state.
      const exhaustive: never = evChargingState;
      void exhaustive;
      return EV_COMMANDABLE_NOW_REASONS.state_unknown;
    }
  }
};

/**
 * EV-boost-context status strings for EV-state cases that block boost
 * activation. Read by the settings-UI boost panel
 * (`packages/settings-ui/src/ui/deviceDetail/evBoost.ts`) — co-located here
 * with the other EV-state-keyed reason strings so both vocabularies live in
 * one browser-safe home, per `feedback_ui_text_shared_with_logs`.
 *
 * The keys mirror the EV-state values that block boost. `plugged_in` (connected
 * but NOT resumable — distinct from the resumable `plugged_in_paused`) blocks
 * too: PELS cannot drive a non-resumable charger, so boost can never activate.
 * The remaining EV states (`plugged_in_paused`, `plugged_in_charging`) allow
 * boost or fall through to the battery-level checks downstream.
 */
export type EvBoostBlockReasonKey = 'plugged_out' | 'plugged_in_discharging' | 'plugged_in';

export const EV_BOOST_BLOCK_REASONS: Record<EvBoostBlockReasonKey, string> = {
  plugged_out: 'Car not connected. Boost will not activate.',
  plugged_in_discharging: 'Car is discharging. Boost will not activate.',
  plugged_in: 'Car charging won’t resume. Boost will not activate.',
};

/**
 * Device-shaped resolver for the boost-block reason so the settings-UI boost
 * panel reads it off the device instead of inlining the plug-state literals
 * (the bug-magnet this de-couple removes). Returns the specific block-reason
 * string for the three boost-blocking states, else `null` (boost not blocked by
 * plug state — fall through to the battery-level checks).
 */
export const resolveEvBoostBlockReason = (dev: { evChargingState?: EvChargingState }): string | null => {
  if (dev.evChargingState === 'plugged_out') return EV_BOOST_BLOCK_REASONS.plugged_out;
  if (dev.evChargingState === 'plugged_in_discharging') return EV_BOOST_BLOCK_REASONS.plugged_in_discharging;
  if (dev.evChargingState === 'plugged_in') return EV_BOOST_BLOCK_REASONS.plugged_in;
  return null;
};
