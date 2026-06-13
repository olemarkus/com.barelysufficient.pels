import type {
  EvChargingState,
  EvObservedProbe,
  ObservedDeviceState,
  StateOfChargeObservedProbe,
} from '../../packages/contracts/src/types';
import type {
    ObservedStateChangedEvent,
    ObservedStateRefreshEvent,
} from './observedStateEvents';

/**
 * Owner-blessed raw read of the observed EV plug-state, for PRODUCER wiring
 * only (the settings-UI read model materializes it as a flat DTO field via
 * `getObservedEvChargingState` in `createPlanService`). `evChargingState` is
 * omitted from `ObservedDeviceState` (EV-observed slice; see `EvObservedFields`
 * in `packages/contracts/src/types.ts`) so consumers cannot read it
 * un-narrowed; the projection's stored values physically carry it (copied by
 * transport's `projectObservedState`), and this helper accepts the
 * probe-widened shape — a plain `ObservedDeviceState` is assignable — to hand
 * the raw value to the one sanctioned seam. Everything else narrows through
 * `isEvObserved`.
 */
export function readObservedEvChargingState(
    state: (ObservedDeviceState & EvObservedProbe) | undefined,
): EvChargingState | undefined {
    return state?.evChargingState;
}

type ProjectionEntry = {
    value: ObservedDeviceState;
    seq?: number;
    observedAtMs?: number;
};

/**
 * Freeze the decided value before it is stored so a reader cannot mutate the
 * projection's truth by reference. Getters hand back the stored object directly,
 * so the freeze must reach every reachable sub-object a consumer could mutate:
 * the record, its `targets` array + each target entry, and the nested observation
 * bags (`binaryControl`, `stateOfCharge`, `binaryControlObservation` and its
 * `observedCapabilityIds` array). `projectObservedState` already builds the value
 * fresh per event with spread-copied bags, so freezing them here is safe (it
 * aliases no producer state) and closes the last by-reference mutation vector —
 * e.g. `getObservedState(id).binaryControl.on = false`. Idempotent and cheap.
 */
function freezeObserved(value: ObservedDeviceState & StateOfChargeObservedProbe): ObservedDeviceState {
    for (const target of value.targets) Object.freeze(target);
    Object.freeze(value.targets);
    if (value.binaryControl) Object.freeze(value.binaryControl);
    if (value.stateOfCharge) Object.freeze(value.stateOfCharge);
    if (value.binaryControlObservation) {
        Object.freeze(value.binaryControlObservation.observedCapabilityIds);
        Object.freeze(value.binaryControlObservation);
    }
    return Object.freeze(value);
}

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
 * Lifecycle: co-created with the transport in `initDeviceManager` (once today —
 * there is no in-process restart path yet) so the projection's per-device seq
 * guard shares the transport's `observationSeq` epoch. Must not be stored
 * anywhere that would outlive a transport rebuild, or a fresh transport's early
 * deltas (lower seqs) would be dropped.
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

    /**
     * Returns the maintained observed truth for a device, or `undefined` when
     * none has been recorded. The value is frozen (see {@link apply}) so a
     * consumer cannot mutate the projection's stored state by reference.
     */
    getObservedState(deviceId: string): ObservedDeviceState | undefined {
        return this.byId.get(deviceId)?.value;
    }

    getAllObservedStates(): ObservedDeviceState[] {
        return Array.from(this.byId.values(), (entry) => entry.value);
    }

    /**
     * Boot/hot-plug seed: fill EMPTY slots from the committed snapshot's observed
     * projection so a reader (the settings-UI EV chip, `toPlanDevice`'s freshness)
     * sees the device's real plug/freshness state for cycle 1, before the first
     * dispatcher delta/refresh lands. Sourced from the RAW cached snapshot
     * (`deviceManager.getSnapshot()` → `projectObservedState`), so it never
     * re-decorates and never re-enters the device manager.
     *
     * Strictly ADDITIVE — and that is the whole safety story:
     * - It writes ONLY when no entry exists for the id (`!this.byId.has`), so it
     *   can never clobber an already-recorded real observation. Per
     *   `feedback_homey_sdk_unreliable`, seeding must not overwrite a fresher
     *   real value; the present-key guard guarantees that without any ordering
     *   comparison.
     * - Seeded entries carry NO `seq` and NO `observedAtMs`, so when the first
     *   real delta/refresh arrives (always a numeric `seq`), `shouldDrop` finds
     *   neither the seq-vs-seq nor the timestamp-vs-timestamp branch applicable
     *   (one side is undefined on each) and falls through to `return false` —
     *   i.e. the real observation ALWAYS supersedes the seed, never the reverse.
     *   The seed therefore cannot win a fresher-wins race or survive a prune
     *   (the next `applyRefresh` overwrites present devices and deletes absent
     *   ones as usual).
     */
    seedMissing(states: readonly ObservedDeviceState[]): void {
        for (const state of states) {
            if (this.byId.has(state.id)) continue;
            // No seq/observedAtMs: a later real observation always wins (see the
            // `shouldDrop` fall-through), and the present-key guard above means we
            // only ever reach a genuinely empty slot here.
            this.byId.set(state.id, { value: freezeObserved(state) });
        }
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
        this.byId.set(value.id, { value: freezeObserved(value), seq, observedAtMs });
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
