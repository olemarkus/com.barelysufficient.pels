import { EventEmitter } from 'events';
import type { ObservedDeviceState } from '../../packages/contracts/src/types';
import type { ObservedDeviceStateRefreshPayload } from '../../packages/contracts/src/observedDeviceState';
import type { ObservedHomePower } from './observedHomePower';

/**
 * Observer-owned typed observation events.
 *
 * Step 7 of the observer/transport split (`notes/state-management/observer-transport-split.md`).
 *
 * Before PR #5, transport emitted these events directly via its own EventEmitter.
 * Post-#5, observer owns the emitter; transport calls observer (via an
 * `ObservedStateEmitterDispatcher` injected by wiring at construction time) so
 * the static `lib/device/` → `lib/observer/` import is avoided and the
 * `no-device-to-peer-except-power` cruiser rule stays intact.
 *
 * Event-name strings are preserved verbatim from their previous transport-side
 * declarations because they are identity-bearing — operator log queries, debug
 * tooling, and the legacy transport-side back-compat emit path (used by direct
 * `DeviceTransport` tests) all match on the same string values.
 */

/**
 * Emitted whenever observer's stored view advances for a device, regardless of
 * whether the change warrants a planner reapply. Wiring uses this for SoC-driven
 * EV-boost rebuild requests, power-sample shortfall invalidation, and live plan
 * state sync; tests that need to observe individual capability events subscribe
 * directly to this event on observer.
 */
export const OBSERVED_STATE_CHANGED_EVENT = 'plan_live_state_observed';

/**
 * Emitted when a realtime observation moved a CONTROL-relevant capability — the
 * binary axis or a target — as opposed to a temperature, SoC or power reading.
 * A fact about the observation, and the producer's judgement of which
 * capabilities are control-relevant; not a plan operation and not an instruction
 * to anyone. It was called `plan-reconcile`, after a lane that no longer exists
 * (root `AGENTS.md` § Control Flow): an observed change triggers no rebuild.
 *
 * Wiring consumes it for the external-off hold and the rebuild-suppression
 * latches (`setup/appInit/planObservedStateSubscription.ts`).
 */
export const OBSERVED_CONTROL_STATE_CHANGED_EVENT = 'observed_control_state_changed';

/**
 * Emitted once per full snapshot refresh (the batch counterpart to the
 * per-capability `OBSERVED_STATE_CHANGED_EVENT`). Carries the decided observed
 * value for every device in the committed snapshot so the observer projection
 * can seed at cold-start and prune vanished devices. Stage 4a of the snapshot
 * decomposition (`notes/state-management/snapshot-decomposition.md`).
 */
export const OBSERVED_STATE_REFRESH_EVENT = 'plan_live_state_observed_refresh';

/**
 * Structural shape of a single capability change. Mirrors transport's
 * `RealtimeDeviceReconcileChange` without importing across the
 * `lib/observer/` ↔ `lib/device/` boundary; both shapes are kept compatible
 * by hand.
 */
export type ObservedCapabilityChange = {
    capabilityId: string;
    previousValue: string;
    nextValue: string;
};

export type ObservedStateChangedEvent = {
    source: 'realtime_capability' | 'device_update';
    deviceId: string;
    observationSeq?: number;
    observedAtMs?: number;
    capabilityId?: string;
    observedCapabilityIds?: string[];
    measurePowerBecameSignificantlyPositive?: boolean;
    // The decided observed value transport's fresher-wins merge produced for
    // this device (Stage 4a). The projection records it; existing reapply/SoC
    // listeners ignore it.
    observed?: ObservedDeviceState;
};

/**
 * Batch payload for a full snapshot refresh. Aliases the shared contracts
 * payload so this observer-side type and transport's
 * `ObservedDeviceStateRefreshEvent` share one definition — neither layer
 * imports the other; both reference contracts.
 */
export type ObservedStateRefreshEvent = ObservedDeviceStateRefreshPayload;

export type ObservedControlStateChangedEvent = {
    deviceId: string;
    observationSeq?: number;
    observedAtMs?: number;
    name?: string;
    capabilityId?: string;
    changes?: ObservedCapabilityChange[];
};

/**
 * Dispatcher passed into `DeviceTransport` at construction time. Wiring builds
 * this against an `ObservedStateEmitter` so that whenever transport finishes
 * translating a Homey realtime event, observer's emitter is the single source
 * of truth for the post-translation fan-out.
 *
 * When omitted (legacy direct-`DeviceTransport` tests), transport falls back
 * to its own EventEmitter using the same event-name strings so existing test
 * subscriptions keep working.
 */
export type ObservedStateEmitterDispatcher = {
    observedStateChanged: (event: ObservedStateChangedEvent) => void;
    observedStateRefresh: (event: ObservedStateRefreshEvent) => void;
    observedControlStateChanged: (event: ObservedControlStateChangedEvent) => void;
    /**
     * Push the gross PV generation reading (watts) into observer's
     * `ObservedHomePower` holder, or `null` when absent, stamped with its read
     * time. The *source* is a Homey SDK energy report read in the device layer;
     * transport resolves the scalar and hands it here. The stamp is carried
     * explicitly because the flow source's separate generation reader rides a
     * different clock, and the holder's consumers must be able to tell a fresh
     * reading from an abandoned one.
     */
    setGenerationW: (w: number | null, observedAtMs: number) => void;
};

/**
 * Tiny typed EventEmitter wrapper owned by wiring (`setup/`) and consumed by
 * wiring listeners. Observer owns the emitter at this physical location so
 * transport can call into it via a callback bag without any static import.
 */
export class ObservedStateEmitter {
    private readonly emitter = new EventEmitter();

    emitObservedStateChanged(event: ObservedStateChangedEvent): void {
        this.emitter.emit(OBSERVED_STATE_CHANGED_EVENT, event);
    }

    emitObservedStateRefresh(event: ObservedStateRefreshEvent): void {
        this.emitter.emit(OBSERVED_STATE_REFRESH_EVENT, event);
    }

    emitObservedControlStateChanged(event: ObservedControlStateChangedEvent): void {
        this.emitter.emit(OBSERVED_CONTROL_STATE_CHANGED_EVENT, event);
    }

    onObservedStateChanged(listener: (event: ObservedStateChangedEvent) => void): void {
        this.emitter.on(OBSERVED_STATE_CHANGED_EVENT, listener);
    }

    /**
     * Returns a disposer that detaches THIS listener. Long-lived boot
     * subscriptions may ignore it; subscribers torn down before the emitter
     * (the multi-home membership wiring at app uninit) must invoke it so a
     * late refresh dispatch cannot reach a disposed consumer.
     */
    onObservedStateRefresh(listener: (event: ObservedStateRefreshEvent) => void): () => void {
        this.emitter.on(OBSERVED_STATE_REFRESH_EVENT, listener);
        return () => { this.emitter.off(OBSERVED_STATE_REFRESH_EVENT, listener); };
    }

    onObservedControlStateChanged(listener: (event: ObservedControlStateChangedEvent) => void): void {
        this.emitter.on(OBSERVED_CONTROL_STATE_CHANGED_EVENT, listener);
    }

    /**
     * Build a dispatcher bound to this emitter and the observer-owned
     * `ObservedHomePower` holder. Wiring passes the returned object into
     * `DeviceTransport`'s constructor so transport's translation pipeline
     * routes through observer's emitter — and its generation reports through
     * observer's holder — without importing observer.
     */
    asDispatcher(homePower: ObservedHomePower): ObservedStateEmitterDispatcher {
        return {
            observedStateChanged: (event) => this.emitObservedStateChanged(event),
            observedStateRefresh: (event) => this.emitObservedStateRefresh(event),
            observedControlStateChanged: (event) => this.emitObservedControlStateChanged(event),
            setGenerationW: (w, observedAtMs) => homePower.setGenerationW(w, observedAtMs),
        };
    }
}
