import type { ObservedDeviceState } from '../../packages/contracts/src/types';
import type {
    ObservedStateChangedEvent,
    ObservedStateRefreshEvent,
} from './observedStateEvents';

type ProjectionEntry = {
    value: ObservedDeviceState;
    seq?: number;
    observedAtMs?: number;
};

/**
 * Observer-owned maintained projection of `ObservedDeviceState`, keyed by
 * deviceId, fed purely by the dispatcher PUSH from transport. Stage 4a of the
 * snapshot decomposition (`notes/state-management/snapshot-decomposition.md`).
 *
 * It only RECORDS the value transport's fresher-wins merge already decided —
 * it never re-merges. The producer attaches the decided value on every event;
 * this class applies it under a sequenced idempotent guard so out-of-order or
 * duplicate deltas can't roll the stored value backward.
 *
 * No `lib/device/` import: the projection consumes only contracts types and the
 * observer-local event types, keeping the `no-observer-to-peer` boundary intact.
 *
 * Lifecycle: constructed alongside the device manager + emitter and recreated
 * with them on a transport restart — never stored anywhere that outlives a
 * transport restart.
 */
export class ObservedDeviceStateProjection {
    private byId: Map<string, ProjectionEntry> = new Map();

    /**
     * Record a per-capability delta. Defensive: a delta with no decided value
     * attached is ignored (nothing to record).
     */
    applyDelta(event: ObservedStateChangedEvent): void {
        if (event.observed === undefined) return;
        this.apply(event.observed, event.observationSeq, event.observedAtMs);
    }

    /**
     * Record a full-refresh batch, then PRUNE devices absent from the batch
     * (mirrors transport's active-id pruning so a vanished device stops being
     * served).
     */
    applyRefresh(event: ObservedStateRefreshEvent): void {
        const presentIds = new Set<string>();
        for (const entry of event.entries) {
            presentIds.add(entry.observed.id);
            this.apply(entry.observed, entry.observationSeq, entry.observedAtMs);
        }
        for (const deviceId of [...this.byId.keys()]) {
            if (!presentIds.has(deviceId)) this.byId.delete(deviceId);
        }
    }

    getObservedState(deviceId: string): ObservedDeviceState | undefined {
        return this.byId.get(deviceId)?.value;
    }

    getAllObservedStates(): ObservedDeviceState[] {
        return Array.from(this.byId.values(), (entry) => entry.value);
    }

    /**
     * Idempotent, ordered apply.
     *
     * Primary key is `observationSeq` — monotonic per device, stamped by
     * transport's `nextObservationCursor`. When both the stored and incoming
     * seqs are numbers and `incoming <= stored`, drop (dedup + out-of-order
     * rejection). The `observedAtMs` comparison is a defensive fallback used
     * only when a seq is absent on either side; it is NOT relied on for
     * ordering, so a DST/clock step (where wall-clock can move backward) cannot
     * corrupt the projection as long as seqs are present — which they always are
     * on the production push path.
     */
    private apply(value: ObservedDeviceState, seq: number | undefined, observedAtMs: number | undefined): void {
        const prev = this.byId.get(value.id);
        if (prev && this.shouldDrop(prev, seq, observedAtMs)) return;
        this.byId.set(value.id, { value, seq, observedAtMs });
    }

    private shouldDrop(prev: ProjectionEntry, seq: number | undefined, observedAtMs: number | undefined): boolean {
        if (typeof prev.seq === 'number' && typeof seq === 'number') {
            // Primary ordering: drop dupes and out-of-order seqs.
            return seq <= prev.seq;
        }
        // Fallback only when a seq is missing on either side.
        if (typeof prev.observedAtMs === 'number' && typeof observedAtMs === 'number') {
            return observedAtMs < prev.observedAtMs;
        }
        // Equal/absent timestamps → accept (last-writer-wins).
        return false;
    }
}
