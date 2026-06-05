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
 * Emitted when an observed change is significant enough that wiring should
 * consider asking the planner to reapply. Wiring still consults the executor's
 * drift detector (`lib/executor/planExecutionDrift.ts`) before scheduling a
 * rebuild — this event only filters out no-op snapshot updates.
 */
export const PLAN_RECONCILE_OBSERVED_EVENT = 'plan_reconcile_realtime_update';

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

export type PlanReconcileObservedEvent = {
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
    planReconcile: (event: PlanReconcileObservedEvent) => void;
    /**
     * Push the latest whole-home power reading (watts) into observer's
     * `ObservedHomePower` holder. The *source* is a Homey SDK energy report
     * read in the device layer; transport resolves the scalar and hands it
     * here. PR2a of the observer/transport split.
     */
    setHomePowerW: (w: number | null) => void;
};

/**
 * Tiny typed EventEmitter wrapper owned by wiring (`lib/app/`) and consumed by
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

    emitPlanReconcile(event: PlanReconcileObservedEvent): void {
        this.emitter.emit(PLAN_RECONCILE_OBSERVED_EVENT, event);
    }

    onObservedStateChanged(listener: (event: ObservedStateChangedEvent) => void): void {
        this.emitter.on(OBSERVED_STATE_CHANGED_EVENT, listener);
    }

    onObservedStateRefresh(listener: (event: ObservedStateRefreshEvent) => void): void {
        this.emitter.on(OBSERVED_STATE_REFRESH_EVENT, listener);
    }

    onPlanReconcile(listener: (event: PlanReconcileObservedEvent) => void): void {
        this.emitter.on(PLAN_RECONCILE_OBSERVED_EVENT, listener);
    }

    /**
     * Build a dispatcher bound to this emitter and the observer-owned
     * `ObservedHomePower` holder. Wiring passes the returned object into
     * `DeviceTransport`'s constructor so transport's translation pipeline
     * routes through observer's emitter — and its home-power reports through
     * observer's home-power holder — without importing observer.
     */
    asDispatcher(homePower: ObservedHomePower): ObservedStateEmitterDispatcher {
        return {
            observedStateChanged: (event) => this.emitObservedStateChanged(event),
            observedStateRefresh: (event) => this.emitObservedStateRefresh(event),
            planReconcile: (event) => this.emitPlanReconcile(event),
            setHomePowerW: (w) => homePower.setHomePowerW(w),
        };
    }
}
