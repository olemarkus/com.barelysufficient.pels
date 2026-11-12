/**
 * Which home batteries PELS only watches for now, owned by the battery control
 * owner (`batteryControlOwner.ts`, whose header says when a battery enters
 * watch-only and what it means). A battery leaves watch-only at the earliest
 * of a restart (this is in memory), a change to its control surface, or
 * `BATTERY_WATCH_ONLY_MS` after it began; the next claim then decides again.
 */
import type { HomeBatteryControlSurface } from '../../packages/contracts/src/types';
import { isSameResponse } from '../ports/homeBatteryResponse';
import { getLogger } from '../logging/logger';
import type { BatteryControlRead, BatterySetpointOutcome } from '../ports/batteryControlOwner';
import type { StorageClaimRejected } from '../ports/storageCommand';
import { isClaimEngaged } from './batteryClaimStanding';

const logger = getLogger('battery');

/** How long a battery whose app rejected PELS's claim stays watch-only before the next claim decides again. */
export const BATTERY_WATCH_ONLY_MS = 6 * 60 * 60_000;

type SetpointSurface = Extract<HomeBatteryControlSurface, { kind: 'setpoint' }>;

/** The battery's setpoint surface as read now, or that it is unseen, has none, or is no battery. */
type CurrentSurface = SetpointSurface | Exclude<BatteryControlRead['kind'], 'setpoint'>;

/** A watch-only battery: the surface its app refused control on, and when. */
type WatchOnlyEntry = { surface: SetpointSurface; sinceMs: number };

/** Whether two reads of a battery's setpoint surface describe the same binding: claim, rejection and range. */
const isSameSurface = (a: SetpointSurface, b: SetpointSurface): boolean => (
  a.claim.capabilityId === b.claim.capabilityId
  && isSameResponse(a.response, b.response)
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
  return typeof surface === 'object' && isSameSurface(refused.surface, surface) ? 'held' : 'control_surface_changed';
};

export class BatteryWatchOnlyLedger {
  private readonly entries = new Map<string, WatchOnlyEntry>();

  /** The battery's app refused control on this surface now. */
  begin(deviceId: string, surface: SetpointSurface, nowMs: number): void {
    this.entries.set(deviceId, { surface, sinceMs: nowMs });
  }

  /**
   * The battery's app rejected the claim write, so no setpoint went out. On a
   * binding whose rejection means the app refuses control, PELS only watches
   * the battery from now on (the owner's header says why), and
   * `forgetNewRecord` drops a claim record the rejected dispatch made; on any
   * other, the storage lane judges the setpoint unanswered.
   */
  judgeClaimRejected(
    deviceId: string,
    battery: BatteryControlRead,
    rejected: StorageClaimRejected,
    forgetNewRecord: () => boolean,
  ): BatterySetpointOutcome {
    const { errorMessage } = rejected;
    // A battery under Homey's claim may be one PELS is driving: leaving it
    // watch-only would strand it at its last setpoint with no hand-back.
    if (
      battery.kind !== 'setpoint'
      || battery.surface.claim.rejection !== 'app_refuses_control'
      || isClaimEngaged(battery)
    ) {
      return { status: 'claim_rejected', effect: 'unanswered', errorMessage };
    }
    this.begin(deviceId, battery.surface, Date.now());
    const recordRemoved = forgetNewRecord();
    logger.warn({
      event: 'battery_control_claim_rejected_watch_only',
      deviceId,
      claimCapabilityId: battery.surface.claim.capabilityId,
      errorMessage,
      recordRemoved,
      watchOnlyMs: BATTERY_WATCH_ONLY_MS,
      msg: 'The battery app rejected control; PELS only watches the battery for 6 h, or until it restarts',
    });
    return { status: 'claim_rejected', effect: 'watch_only', errorMessage };
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
