import type {
  ObservedStateOfCharge,
  EvChargingState,
  EvObservedProbe,
  HomeBatteryControlCapability,
  HomeBatteryDescriptorProbe,
  HomeBatteryObservedProbe,
  ObservedDeviceState,
  ProjectedObservedDeviceState,
  StateOfChargeObservedProbe,
  TemperatureObservedProbe,
  ThermalDirection,
} from '../../packages/contracts/src/types';
import type {
    ObservedStateChangedEvent,
    ObservedStateRefreshEvent,
} from './observedStateEvents';
import { resolveThermalDirection } from './thermalDirection';
import { hasLiveMeasuredPower } from '../../packages/shared-domain/src/measuredPowerObservedState';

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
export type ObservedEvChargingStateRead =
    | { kind: 'observed'; value: EvChargingState }
    | { kind: 'absent' };

export function readObservedEvChargingState(
    state: (ObservedDeviceState & EvObservedProbe) | undefined,
): ObservedEvChargingStateRead {
    const evChargingState = state?.evChargingState;
    if (evChargingState === undefined) return { kind: 'absent' };
    return { kind: 'observed', value: evChargingState };
}

/**
 * Semantic result at the observer boundary, exactly like
 * `ObservedTemperatureRead` below. Absence is explicit so adjacent layers never
 * reinterpret a nullable reading as evidence or a default.
 *
 * `absent` means THE OBSERVER has no state-of-charge observation for this
 * device: no projection entry at all, or an entry carrying none. It is not a
 * statement about the device — a caller holding another source may still find
 * one, which is what the settings-UI projection's fallback does.
 *
 * Neither arm means "no level". That is `value.level.kind`, a statement the
 * transport resolved about a device that does report one.
 */
export type ObservedStateOfChargeRead =
    | { kind: 'observed'; value: ObservedStateOfCharge }
    | { kind: 'absent' };

/**
 * Owner projection of the observed state-of-charge cluster for producer wiring.
 * `stateOfCharge` is omitted from `ObservedDeviceState` (state-of-charge-observed
 * slice) and the projection's stored values physically carry it, so this seam
 * probe-widens to reach it — and resolves it, so that nothing downstream has to.
 *
 * Whether a level is usable is the `level` discriminant the transport already
 * resolved (`notes/ev-soc-layering.md`); this reads no freshness and applies no
 * gate of its own.
 */
export function readObservedStateOfCharge(
    state: (ObservedDeviceState & StateOfChargeObservedProbe) | undefined,
): ObservedStateOfChargeRead {
    const stateOfCharge = state?.stateOfCharge;
    if (!stateOfCharge) return { kind: 'absent' };
    return { kind: 'observed', value: { level: stateOfCharge.level } };
}

/**
 * Whether PELS could drive a home battery, as its card says it: `drivable` (a
 * `setpoint` control surface), `observe_only` (none), or `watch_only` (a
 * setpoint surface whose app refused PELS's claim for now: the battery
 * owner's `isWatchOnly`). The settings UI and the Flow cards read the same
 * answer from the owner (`readControlCapability`).
 */
export type HomeBatteryCardControl = HomeBatteryControlCapability;

/**
 * A home battery as its overview card reads it: whether PELS could drive it
 * (`HomeBatteryCardControl`), and its own power and level, each explicit when
 * the battery has not reported one. `none`: the device is not a home battery.
 */
export type HomeBatteryCardRead =
    | { kind: 'none' }
    | {
        kind: 'battery';
        control: HomeBatteryCardControl;
        power: { kind: 'observed'; signedW: number } | { kind: 'absent' };
        level: { kind: 'observed'; percent: number } | { kind: 'absent' };
    };

/**
 * Owner read of a home battery's card facts for producer wiring: the
 * descriptor the transport resolved at parse (`homeBattery`), the signed
 * power and level the observer projection carries, and whether the battery
 * owner only watches it (`watchOnly`, its `isWatchOnly`). Nothing here decides
 * on any of them.
 */
export function readHomeBatteryCard(
    descriptor: HomeBatteryDescriptorProbe | undefined,
    state: (ObservedDeviceState & HomeBatteryObservedProbe) | undefined,
    watchOnly: boolean,
): HomeBatteryCardRead {
    const surface = descriptor?.homeBattery?.controlSurface;
    if (surface === undefined) return { kind: 'none' };
    const power = state?.batteryPower;
    const level = state?.batteryLevel;
    const setpointControl: HomeBatteryCardControl = watchOnly ? 'watch_only' : 'drivable';
    const control: HomeBatteryCardControl = surface.kind === 'setpoint' ? setpointControl : 'observe_only';
    return {
        kind: 'battery',
        control,
        power: power === undefined ? { kind: 'absent' } : { kind: 'observed', signedW: power.signedW },
        level: level === undefined ? { kind: 'absent' } : { kind: 'observed', percent: level.percent },
    };
}

/**
 * The observed temperature PAIR, as the observer hands it to producer wiring.
 * Named (not spelled inline at each consumer) so a rename cannot drift between
 * the projection, the plan-service dep, the read-model dep, and the idle
 * classifier's input — all four carry this same fact.
 *
 * Distinct from the plan/overview trio (`TemperatureKind` /
 * `PlannedTemperatureState`): that one adds the planner's `plannedTarget`,
 * which the observer has no opinion about.
 */
export type ObservedTemperatureState = {
    currentTarget: number;
    currentTemperature: number;
};

/**
 * Semantic result at the observer boundary. Absence is explicit so adjacent
 * layers never reinterpret a nullable reading as evidence or a default.
 */
export type ObservedTemperatureRead =
    | { kind: 'observed'; value: ObservedTemperatureState }
    | { kind: 'absent' };

/**
 * Owner projection of the observed temperature cluster for producer wiring.
 * The observer facet is atomic: `observed` always carries both numbers admitted
 * together by the transport boundary; `absent` carries no fabricated stand-in.
 */
export function readObservedTemperatureState(
    state: (ObservedDeviceState & TemperatureObservedProbe) | undefined,
): ObservedTemperatureRead {
    if (state === undefined) return { kind: 'absent' };
    const temperature = state.temperature;
    if (!temperature) return { kind: 'absent' };
    return {
        kind: 'observed',
        value: {
            currentTarget: temperature.target.value,
            currentTemperature: temperature.currentTemperature,
        },
    };
}

type ProjectionEntry = {
    value: ProjectedObservedDeviceState;
    seq?: number;
    observedAtMs?: number;
};

/**
 * Freeze the decided value before it is stored so a reader cannot mutate the
 * projection's truth by reference. Getters hand back the stored object directly,
 * so the freeze must reach every reachable sub-object a consumer could mutate:
 * the record, its `targets` array + each target entry, and the nested observation
 * bags (`binaryControl`, `stateOfCharge` — including its own nested `level`,
 * `report` and `source` — `batteryPower`, `batteryClaim`, `batteryLevel`,
 * `binaryControlObservation` and its
 * `observedCapabilityIds` array). The state-of-charge bag needs the inner three
 * named explicitly: they are objects, so the outer freeze leaves them writable,
 * and `report.percent` / `source.carId` would still be assignable through a
 * getter's return value. `projectObservedState` already builds the value
 * fresh per event with spread-copied bags, so freezing them here is safe (it
 * aliases no producer state) and closes the last by-reference mutation vector —
 * e.g. `getObservedState(id).binaryControl.on = false`. Idempotent and cheap.
 */
function freezeObserved(value: ProjectedObservedDeviceState): ProjectedObservedDeviceState {
    for (const target of value.targets) Object.freeze(target);
    Object.freeze(value.targets);
    if (value.binaryControl) Object.freeze(value.binaryControl);
    if (value.temperature) {
        Object.freeze(value.temperature.target);
        Object.freeze(value.temperature);
    }
    if (value.stateOfCharge) {
        Object.freeze(value.stateOfCharge.level);
        Object.freeze(value.stateOfCharge.report);
        Object.freeze(value.stateOfCharge.source);
        Object.freeze(value.stateOfCharge);
    }
    if (value.batteryPower) Object.freeze(value.batteryPower);
    if (value.batteryClaim) Object.freeze(value.batteryClaim);
    if (value.batteryLevel) Object.freeze(value.batteryLevel);
    if (value.binaryControlObservation) {
        Object.freeze(value.binaryControlObservation.observedCapabilityIds);
        Object.freeze(value.binaryControlObservation);
    }
    if (value.steppedLoadProfile) {
        for (const step of value.steppedLoadProfile.steps) Object.freeze(step);
        Object.freeze(value.steppedLoadProfile.steps);
        Object.freeze(value.steppedLoadProfile);
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

    private revision = 0;

    /**
     * Monotonic counter of ACCEPTED writes to this projection.
     *
     * It answers one question — "is the observed world still the one you read
     * earlier?" — for a caller that captured a value and then yielded. A dropped
     * duplicate or out-of-order delta does not advance it, because nothing the
     * caller could observe changed.
     *
     * Deliberately whole-projection rather than per device. The consumer is a
     * fail-closed guard (`hasExecutionWorkOutstanding`): a coarser counter can
     * only make it decline to act, never make it act on something stale, and
     * declining costs one cycle. A per-device counter would be more precise and
     * would have to be right about which devices matter — precision bought at
     * the cost of the safe failure direction.
     */
    getRevision(): number {
        return this.revision;
    }

    /**
     * Record a per-capability delta. Defensive: a delta with no decided value
     * attached is ignored (nothing to record).
     */
    applyDelta(event: ObservedStateChangedEvent): void {
        if (event.observed === undefined) return;
        this.apply(event.observed, event.observationSeq, event.observedAtMs);
    }

    /**
     * Record a refresh batch, then PRUNE devices absent from the batch (mirrors
     * transport's active-id pruning so a vanished device stops being served).
     *
     * The committed snapshot driving this batch is always complete truth for the
     * known device set: a FULL read knows every device, and a TARGETED
     * (update-only) refresh is overlaid with the per-device miss grace BEFORE it
     * is committed — a device that merely failed one by-id read is retained in
     * the batch (so it is not pruned here), and a device only drops out once it
     * has exceeded the grace (a genuine removal). So pruning to the batch is
     * always correct.
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
     * The maintained observed truth for a device, or `undefined` when none has
     * been recorded. The value is frozen (see {@link apply}) so a consumer cannot
     * mutate the projection's stored state by reference.
     *
     * Wide, and deliberately so: this is the OWNER's read, and the record is what
     * the owner holds. It has exactly one caller — `setup/appRuntimeApi.ts` — and
     * that is where the narrowing happens: the app hands consumers
     * `ObservedDeviceState` from `getObservedState`, resolves each cluster through
     * its own named read, and passes the whole record only to the settings-UI
     * payload refresh, which overlays raw fields and so genuinely holds it.
     *
     * Keep that one caller. A second one is the general exit re-opening: while the
     * app's own getter handed this out, every consumer wired to it could read any
     * cluster raw, and the raw way won by being shorter than the resolved one.
     */
    getObservedState(deviceId: string): ProjectedObservedDeviceState | undefined {
        return this.byId.get(deviceId)?.value;
    }

    /**
     * Which way this device's setpoint moves demand, always. The projection owns
     * the answer for a device it holds no record of, because it is the one that
     * knows there is none: nothing has reported a mode for it, and a device with
     * no mode is heating.
     */
    getThermalDirection(deviceId: string): ThermalDirection {
        const entry = this.byId.get(deviceId);
        return entry === undefined ? 'heating' : resolveThermalDirection(entry.value);
    }

    /**
     * Whether this device's power reading is a live measurement of its draw
     * (`hasLiveMeasuredPower`). False for a device with no record: nothing has
     * reported a reading for it.
     */
    isLiveMeasuredDraw(deviceId: string): boolean {
        const entry = this.byId.get(deviceId);
        return entry !== undefined && hasLiveMeasuredPower(entry.value);
    }

    /**
     * Narrow, unlike its single-device sibling above: that one has an owner-side
     * caller that needs the record, this one has no production caller at all —
     * only the projection's own specs. Closing it before it acquires one costs
     * nothing, and a caller enumerating devices has no more business reading a raw
     * cluster than one asking about a single device.
     */
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
    private apply(
        value: ProjectedObservedDeviceState,
        seq: number | undefined,
        observedAtMs: number | undefined,
    ): void {
        const prev = this.byId.get(value.id);
        if (prev && this.shouldDrop(prev, seq, observedAtMs)) return;
        this.byId.set(value.id, { value: freezeObserved(value), seq, observedAtMs });
        this.revision += 1;
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
