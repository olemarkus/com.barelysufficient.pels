import type { ExternalTemperatureAdjustment } from '../../packages/contracts/src/temperatureAdjustment';
import { EventEmitter } from 'events';
import type {
    ObservedControlStateChangedEvent,
    ObservedStateChangedEvent,
    ObservedStateEmitterDispatcher,
    ObservedStateRefreshEvent,
} from '../ports/observedStateEvents';
import type { ObservedHomePower } from './observedHomePower';

// The event shapes are shared with transport, which may not import observer;
// they live in `lib/ports/observedStateEvents.ts`.
export type {
    ObservedControlStateChangedEvent,
    ObservedStateChangedEvent,
    ObservedStateRefreshEvent,
};

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
 * declarations because they are identity-bearing — operator log queries and
 * debug tooling match on these values. Transport kept a second declaration of
 * them for its back-compat emit path; that path and its constants are gone, so
 * this file is now their only declaration site.
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
 * Tiny typed EventEmitter wrapper owned by wiring (`setup/`) and consumed by
 * wiring listeners. Observer owns the emitter at this physical location so
 * transport can call into it via an injected dispatcher without any static
 * import.
 */
export class ObservedStateEmitter {
    private readonly emitter = new EventEmitter();

    onExternalTemperatureAdjusted(listener: (adjustment: ExternalTemperatureAdjustment) => void): void {
        this.emitter.on('external_temperature_adjusted', listener);
    }

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
            externalTemperatureAdjusted: (adjustment) => {
                this.emitter.emit('external_temperature_adjusted', adjustment);
            },
            observedStateChanged: (event) => this.emitObservedStateChanged(event),
            observedStateRefresh: (event) => this.emitObservedStateRefresh(event),
            observedControlStateChanged: (event) => this.emitObservedControlStateChanged(event),
            setGenerationW: (w, observedAtMs) => homePower.setGenerationW(w, observedAtMs),
        };
    }
}
