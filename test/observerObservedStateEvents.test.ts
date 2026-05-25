import { describe, expect, it, vi } from 'vitest';
import {
  OBSERVED_STATE_CHANGED_EVENT,
  ObservedStateEmitter,
  PLAN_RECONCILE_OBSERVED_EVENT,
  type ObservedStateChangedEvent,
  type PlanReconcileObservedEvent,
} from '../lib/observer/observedStateEvents';
import {
  PLAN_LIVE_STATE_OBSERVED_EVENT,
  PLAN_RECONCILE_REALTIME_UPDATE_EVENT,
} from '../lib/device/deviceTransport';

describe('ObservedStateEmitter', () => {
  it('preserves the legacy event-name strings for operator/log compatibility', () => {
    // These literals are identity-bearing: operator log queries, debug
    // tooling, and the legacy transport-side back-compat emit path all
    // match on the same values. PR #5 of the observer/transport split
    // moved the emitter, not the strings.
    expect(OBSERVED_STATE_CHANGED_EVENT).toBe('plan_live_state_observed');
    expect(PLAN_RECONCILE_OBSERVED_EVENT).toBe('plan_reconcile_realtime_update');
  });

  it('keeps the observer-side and transport-side event constants in lockstep', () => {
    // Transport keeps its own constants for the back-compat fallback path
    // (`this.emit(...)` when no dispatcher is supplied) so legacy tests
    // can subscribe to its EventEmitter. The two declaration sites are
    // structurally separate per the cruiser rules; this pin catches a
    // one-sided rename before it silently fragments operator log queries
    // or routes the dispatcher and fallback to different event names.
    expect(OBSERVED_STATE_CHANGED_EVENT).toBe(PLAN_LIVE_STATE_OBSERVED_EVENT);
    expect(PLAN_RECONCILE_OBSERVED_EVENT).toBe(PLAN_RECONCILE_REALTIME_UPDATE_EVENT);
  });

  it('emits observed-state-changed events through the dispatcher to subscribed listeners', () => {
    const emitter = new ObservedStateEmitter();
    const dispatcher = emitter.asDispatcher();
    const listener = vi.fn();
    emitter.onObservedStateChanged(listener);

    const event: ObservedStateChangedEvent = {
      source: 'realtime_capability',
      deviceId: 'dev-1',
      observationSeq: 7,
      observedAtMs: 100,
      capabilityId: 'onoff',
    };
    dispatcher.observedStateChanged(event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('emits plan-reconcile events through the dispatcher to subscribed listeners', () => {
    const emitter = new ObservedStateEmitter();
    const dispatcher = emitter.asDispatcher();
    const listener = vi.fn();
    emitter.onPlanReconcile(listener);

    const event: PlanReconcileObservedEvent = {
      deviceId: 'dev-2',
      observationSeq: 3,
      observedAtMs: 200,
      name: 'Heater',
      changes: [{
        capabilityId: 'onoff',
        previousValue: 'on',
        nextValue: 'off',
      }],
    };
    dispatcher.planReconcile(event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('routes direct emitter calls to listeners (used by binarySettle drift escalation)', () => {
    const emitter = new ObservedStateEmitter();
    const observedListener = vi.fn();
    const reconcileListener = vi.fn();
    emitter.onObservedStateChanged(observedListener);
    emitter.onPlanReconcile(reconcileListener);

    emitter.emitObservedStateChanged({
      source: 'device_update',
      deviceId: 'dev-3',
    });
    emitter.emitPlanReconcile({
      deviceId: 'dev-3',
    });

    expect(observedListener).toHaveBeenCalledTimes(1);
    expect(reconcileListener).toHaveBeenCalledTimes(1);
  });

  it('keeps observed-state and plan-reconcile channels independent', () => {
    const emitter = new ObservedStateEmitter();
    const observedListener = vi.fn();
    const reconcileListener = vi.fn();
    emitter.onObservedStateChanged(observedListener);
    emitter.onPlanReconcile(reconcileListener);

    emitter.emitObservedStateChanged({
      source: 'realtime_capability',
      deviceId: 'dev-4',
    });

    expect(observedListener).toHaveBeenCalledTimes(1);
    expect(reconcileListener).not.toHaveBeenCalled();
  });
});
