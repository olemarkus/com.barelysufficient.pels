/**
 * Pure commandability resolution, shared across layers.
 *
 * Lives in `packages/shared-domain` (not `lib/device`) so every layer that needs
 * the answer can import it legally: the device producer, the planner, AND the
 * executor (`lib/executor` may not import `lib/device` internals — the
 * `no-executor-to-device-internals` cruiser rule). Pure and browser-safe; the
 * plug-state classification it composes lives in `evPlugState.ts` and the
 * owner-facing wording in `commandableNowReason.ts`.
 */
import { isEvObserved } from './evObservedState';
import { isEvPlugStateCommandable } from './evPlugState';
import type { EvObservedProbe } from '../../contracts/src/types';

export { isEvDevice } from './evPlugState';

/**
 * The observed facts commandability is decided from. `evChargingState` is absent
 * for exactly one reason — the device is not an EV charger — because an EV
 * charger that cannot report a valid plug-state is dropped at the parse boundary
 * rather than admitted without one (see `evPlugState.ts`).
 */
export type CommandableNowInput = {
  deviceClass?: string;
  controlCapabilityId?: string;
  available?: boolean;
} & EvObservedProbe;

/**
 * Can the controller issue a control command to this device right now and expect
 * it to land and matter? A plain boolean: the two inputs are the EV plug-state
 * (for an EV charger) and the device's availability, and neither the answer nor
 * anything derived from it is carried alongside the device — consumers that need
 * to explain the answer derive that from the same observed state, at the surface
 * that renders it (`resolveCommandabilityDetail`).
 *
 * The producer-injected resume-probe backoff is folded in downstream by
 * `toPlanDevice` (`projectCommandability`), not here: it is executor-owned
 * runtime state, not an observed fact.
 *
 * `isEvObserved` is the narrowing seam. Its false arm for a device that IS an EV
 * charger is unreachable by producer contract; if one ever did reach here it
 * would read as commandable, which is the safe direction — refusing to command
 * is a one-way door, because shed selection does not consult commandability
 * while both restore paths do, so a charger PELS refuses to command is one it
 * can turn off and never turn back on.
 */
export function resolveCommandableNow(dev: CommandableNowInput): boolean {
  if (isEvObserved(dev) && !isEvPlugStateCommandable(dev.evChargingState)) return false;
  return dev.available !== false;
}

/**
 * Consumer read of the producer-resolved bit. NOT a dual-read: nothing
 * re-resolves from raw fields, because a carrier that had lost them would answer
 * from absence. That is how `isCommandableNow` came to report `false` for every
 * plan device once `withEvDiscriminant` stripped the plug-state — the fallback
 * saw nothing and answered anyway (TODO 2026-07-25). Callers holding a raw
 * snapshot call {@link resolveCommandableNow} explicitly.
 */
export function isCommandableNow(dev: { commandableNow: boolean }): boolean {
  return dev.commandableNow;
}
