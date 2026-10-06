/**
 * Which home batteries PELS only watches for now, owned by the battery control
 * owner (`batteryControlOwner.ts`, whose header says when a battery enters
 * watch-only and what it means). A battery leaves watch-only at the earliest
 * of a restart (this is in memory), a change to its control surface, or
 * `BATTERY_WATCH_ONLY_MS` after it began; the next claim then decides again.
 */
import type { HomeBatteryControlSurface } from '../../packages/contracts/src/types';
import { getLogger } from '../logging/logger';

const logger = getLogger('battery');

/** How long a battery whose app rejected PELS's claim stays watch-only before the next claim decides again. */
export const BATTERY_WATCH_ONLY_MS = 6 * 60 * 60_000;

type SetpointSurface = Extract<HomeBatteryControlSurface, { kind: 'setpoint' }>;

/** The battery's setpoint surface as read now, or that it is unseen or has none. */
type CurrentSurface = SetpointSurface | 'unobserved' | 'observe_only';

/** A watch-only battery: the surface its app refused control on, and when. */
type WatchOnlyEntry = { surface: SetpointSurface; sinceMs: number };

/** Whether two reads of a battery's setpoint surface describe the same binding: claim, rejection and range. */
const isSameSurface = (a: SetpointSurface, b: SetpointSurface): boolean => (
  a.claim.capabilityId === b.claim.capabilityId
  && a.claim.homeyValue === b.claim.homeyValue
  && a.claim.rejection === b.claim.rejection
  && a.claim.values.length === b.claim.values.length
  && a.claim.values.every((value, index) => value === b.claim.values[index])
  && a.range.minW === b.range.minW
  && a.range.maxW === b.range.maxW
  && a.range.stepW === b.range.stepW
  && a.range.excludeMinW === b.range.excludeMinW
  && a.range.excludeMaxW === b.range.excludeMaxW
);

/** Whether a watch-only battery stays so: its time is up, its surface changed, or it is `held`. */
const resolveWatchOnlyEnd = (
  refused: WatchOnlyEntry,
  surface: CurrentSurface,
  nowMs: number,
): 'held' | 'expired' | 'control_surface_changed' => {
  if (nowMs - refused.sinceMs >= BATTERY_WATCH_ONLY_MS) return 'expired';
  // An unseen battery has shown no new surface.
  if (surface === 'unobserved') return 'held';
  return surface !== 'observe_only' && isSameSurface(refused.surface, surface) ? 'held' : 'control_surface_changed';
};

export class BatteryWatchOnlyLedger {
  private readonly entries = new Map<string, WatchOnlyEntry>();

  /** The battery's app refused control on this surface now. */
  begin(deviceId: string, surface: SetpointSurface, nowMs: number): void {
    this.entries.set(deviceId, { surface, sinceMs: nowMs });
  }

  /** Whether the battery is still watch-only against its surface as read now; an ended one is forgotten and logged. */
  isWatchOnly(deviceId: string, surface: CurrentSurface, nowMs: number): boolean {
    const refused = this.entries.get(deviceId);
    if (refused === undefined) return false;
    const reason = resolveWatchOnlyEnd(refused, surface, nowMs);
    if (reason === 'held') return true;
    this.entries.delete(deviceId);
    logger.info({ event: 'battery_control_watch_only_cleared', deviceId, reason });
    return false;
  }
}
