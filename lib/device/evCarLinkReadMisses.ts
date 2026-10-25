/**
 * Which tracked cars a successful device read removes.
 *
 * A FULL read is authoritative on membership: a car it does not list is gone. A
 * targeted read requests every tracked car by id, so an absent car was either
 * deleted or transiently unreadable. Those are indistinguishable in one read,
 * and the periodic refresh is ALWAYS targeted — so without a miss count a
 * deleted car is never dropped, keeps being requested, and stays an affinity
 * candidate forever. One miss cannot tell the two apart either, and
 * post-actuation and stuck-command refreshes arrive in bursts, so a car is
 * dropped only on the snapshot's own count-plus-wall-clock grace
 * (`advanceTargetedMiss`).
 *
 * Split from `evCarLinkProducer.ts` so that file stays within its size ceiling.
 */
import { advanceTargetedMiss, type TargetedMissState } from './transport/targetedSnapshotMerge';

export class EvCarLinkReadMisses {
    private readonly missesByCarId = new Map<string, TargetedMissState>();

    /**
     * The cars among `trackedIds` this read removes. `seen` are the cars the read
     * returned; `ignoredIds` are listed but their read was ignored, which is
     * present and unread: not a miss, and not evidence of anything.
     */
    removedBy(
        trackedIds: readonly string[],
        seen: ReadonlySet<string>,
        ignoredIds: ReadonlySet<string>,
        fullRefresh: boolean,
        nowMs: number,
    ): string[] {
        return trackedIds.filter((carId) => {
            if (seen.has(carId)) {
                this.missesByCarId.delete(carId);
                return false;
            }
            if (ignoredIds.has(carId)) return false;
            if (fullRefresh) return true;
            const { state, graceExceeded } = advanceTargetedMiss(this.missesByCarId.get(carId), nowMs);
            this.missesByCarId.set(carId, state);
            return graceExceeded;
        });
    }

    forget(carId: string): void {
        this.missesByCarId.delete(carId);
    }
}
