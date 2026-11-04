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
import { isEvDevice, isEvPlugStateCommandable, type EvDeviceIdentity } from './evPlugState';
import type { EvObservedProbe } from '../../contracts/src/types';

export { isEvDevice } from './evPlugState';

/**
 * The observed facts commandability is decided from. A charger's independent
 * observations remain usable before its plug state is first reported, but
 * without that state PELS cannot establish permission to start a session.
 */
export type CommandableNowInput = EvDeviceIdentity & {
  available: boolean;
} & EvObservedProbe;

/**
 * Can the controller issue a control command to this device right now and expect
 * it to land and matter? A plain boolean: the two inputs are the EV plug-state
 * (for an EV charger) and the device's availability, and neither the answer nor
 * anything derived from it is carried alongside the device — consumers that need
 * to explain the answer derive that from the same observed state, at the surface
 * that renders it (`resolveCommandabilityDetail`).
 *
 * An EV without an accepted plug observation remains visible but cannot start.
 */
export function resolveCommandableNow(dev: CommandableNowInput): boolean {
  if (isEvDevice(dev) && (!isEvObserved(dev) || !isEvPlugStateCommandable(dev.evChargingState))) return false;
  return dev.available;
}

/**
 * Consumer read of the producer-resolved bit. NOT a dual-read: nothing
 * re-resolves from raw fields, because a carrier that had lost them would answer
 * from absence. That is how `isCommandableNow` came to report `false` for every
 * plan device once the since-deleted `withEvDiscriminant` stripped the plug-state — the fallback
 * saw nothing and answered anyway (2026-07-25). Callers holding a raw
 * snapshot call {@link resolveCommandableNow} explicitly.
 */
export function isCommandableNow(dev: { commandableNow: boolean }): boolean {
  return dev.commandableNow;
}
