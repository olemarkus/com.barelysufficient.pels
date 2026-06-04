import { describe, expect, it, vi } from 'vitest';
import {
  OBSERVED_STATE_CHANGED_EVENT,
  ObservedStateEmitter,
  PLAN_RECONCILE_OBSERVED_EVENT,
  type ObservedStateChangedEvent,
  type ObservedStateEmitterDispatcher,
  type PlanReconcileObservedEvent,
} from '../lib/observer/observedStateEvents';
import { ObservedHomePower } from '../lib/observer/observedHomePower';
import {
  PLAN_LIVE_STATE_OBSERVED_EVENT,
  PLAN_RECONCILE_REALTIME_UPDATE_EVENT,
  type TransportObservedStateDispatcher,
} from '../lib/device/deviceTransport';

// ---------- compile-time shape-parity guard ----------
// Observer's `ObservedStateEmitterDispatcher` and transport's
// `TransportObservedStateDispatcher` are structurally mirrored by hand
// because the cruiser correctly blocks both directions of import between
// `lib/device/` and `lib/observer/`. The wiring at `app.ts` passes the
// observer dispatcher into transport's slot; TypeScript bivariance bridges
// the two — which means a future field added to one side without the other
// will silently typecheck at the binding site but route the wrong shape at
// runtime. The asserted-true assignments below force a *strict* bidirectional
// `extends` check; if shapes diverge, this file will fail compilation BEFORE
// it ever runs as a test. Added per the TODO entry produced by the
// post-merge cumulative review of the observer/transport split train.
type _MutuallyAssignable<A, B> = [
  A extends B ? true : false,
  B extends A ? true : false,
];

const _observedStateChangedEventParity: _MutuallyAssignable<
  Parameters<ObservedStateEmitterDispatcher['observedStateChanged']>[0],
  Parameters<TransportObservedStateDispatcher['observedStateChanged']>[0]
> = [true, true];

const _planReconcileEventParity: _MutuallyAssignable<
  Parameters<ObservedStateEmitterDispatcher['planReconcile']>[0],
  Parameters<TransportObservedStateDispatcher['planReconcile']>[0]
> = [true, true];

const _setHomePowerWParity: _MutuallyAssignable<
  Parameters<ObservedStateEmitterDispatcher['setHomePowerW']>[0],
  Parameters<TransportObservedStateDispatcher['setHomePowerW']>[0]
> = [true, true];

// Reference the values so the compiler doesn't strip them as unused.
void _observedStateChangedEventParity;
void _planReconcileEventParity;
void _setHomePowerWParity;

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
    const dispatcher = emitter.asDispatcher(new ObservedHomePower());
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
    const dispatcher = emitter.asDispatcher(new ObservedHomePower());
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

  it('routes home-power reports through the dispatcher into the observer holder', () => {
    // PR2a of the observer/transport split: transport pushes the
    // Homey-SDK-sourced home-power scalar via the dispatcher; observer's
    // `ObservedHomePower` holder owns the read.
    const emitter = new ObservedStateEmitter();
    const homePower = new ObservedHomePower();
    const dispatcher = emitter.asDispatcher(homePower);

    expect(homePower.getHomePowerW()).toBeNull();

    dispatcher.setHomePowerW(2400);
    expect(homePower.getHomePowerW()).toBe(2400);

    dispatcher.setHomePowerW(null);
    expect(homePower.getHomePowerW()).toBeNull();
  });
});

describe('ObservedHomePower', () => {
  it('returns null before any report is pushed', () => {
    expect(new ObservedHomePower().getHomePowerW()).toBeNull();
  });

  it('returns the last pushed reading', () => {
    const homePower = new ObservedHomePower();
    homePower.setHomePowerW(1500);
    expect(homePower.getHomePowerW()).toBe(1500);
    homePower.setHomePowerW(3200);
    expect(homePower.getHomePowerW()).toBe(3200);
  });

  it('can be cleared back to null', () => {
    const homePower = new ObservedHomePower();
    homePower.setHomePowerW(800);
    homePower.setHomePowerW(null);
    expect(homePower.getHomePowerW()).toBeNull();
  });
});
