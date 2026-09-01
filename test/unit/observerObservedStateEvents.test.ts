import { describe, expect, it, vi } from 'vitest';
import {
  OBSERVED_STATE_CHANGED_EVENT,
  ObservedStateEmitter,
  OBSERVED_CONTROL_STATE_CHANGED_EVENT,
  type ObservedStateChangedEvent,
  type ObservedStateEmitterDispatcher,
  type ObservedControlStateChangedEvent,
} from '../../lib/observer/observedStateEvents';
import { ObservedHomePower } from '../../lib/observer/observedHomePower';
import {
  PLAN_LIVE_STATE_OBSERVED_EVENT,
  OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT,
  type TransportObservedStateDispatcher,
} from '../../lib/device/deviceTransport';

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

const _observedControlStateChangedEventParity: _MutuallyAssignable<
  Parameters<ObservedStateEmitterDispatcher['observedControlStateChanged']>[0],
  Parameters<TransportObservedStateDispatcher['observedControlStateChanged']>[0]
> = [true, true];

const _observedStateRefreshParity: _MutuallyAssignable<
  Parameters<ObservedStateEmitterDispatcher['observedStateRefresh']>[0],
  Parameters<TransportObservedStateDispatcher['observedStateRefresh']>[0]
> = [true, true];

const _setGenerationWParity: _MutuallyAssignable<
  Parameters<ObservedStateEmitterDispatcher['setGenerationW']>,
  Parameters<TransportObservedStateDispatcher['setGenerationW']>
> = [true, true];

// Reference the values so the compiler doesn't strip them as unused.
void _observedStateChangedEventParity;
void _observedControlStateChangedEventParity;
void _observedStateRefreshParity;
void _setGenerationWParity;

describe('ObservedStateEmitter', () => {
  it('pins the event-name strings the two declaration sites share', () => {
    // These literals are the channel names on the EventEmitter, and the legacy
    // transport-side back-compat emit path matches on the same values. They are
    // NOT log fields — grep finds them nowhere but these two declarations, which
    // is why `plan_reconcile_realtime_update` could be renamed with the lane it
    // was named after (root `AGENTS.md` § Control Flow).
    expect(OBSERVED_STATE_CHANGED_EVENT).toBe('plan_live_state_observed');
    expect(OBSERVED_CONTROL_STATE_CHANGED_EVENT).toBe('observed_control_state_changed');
  });

  it('keeps the observer-side and transport-side event constants in lockstep', () => {
    // Transport keeps its own constants for the back-compat fallback path
    // (`this.emit(...)` when no dispatcher is supplied) so legacy tests
    // can subscribe to its EventEmitter. The two declaration sites are
    // structurally separate per the cruiser rules; this pin catches a
    // one-sided rename before it silently fragments operator log queries
    // or routes the dispatcher and fallback to different event names.
    expect(OBSERVED_STATE_CHANGED_EVENT).toBe(PLAN_LIVE_STATE_OBSERVED_EVENT);
    expect(OBSERVED_CONTROL_STATE_CHANGED_EVENT).toBe(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT);
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

  it('emits observed-control-state-changed events through the dispatcher to subscribed listeners', () => {
    const emitter = new ObservedStateEmitter();
    const dispatcher = emitter.asDispatcher(new ObservedHomePower());
    const listener = vi.fn();
    emitter.onObservedControlStateChanged(listener);

    const event: ObservedControlStateChangedEvent = {
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
    dispatcher.observedControlStateChanged(event);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('routes direct emitter calls to listeners (used by binarySettle drift escalation)', () => {
    const emitter = new ObservedStateEmitter();
    const observedListener = vi.fn();
    const reconcileListener = vi.fn();
    emitter.onObservedStateChanged(observedListener);
    emitter.onObservedControlStateChanged(reconcileListener);

    emitter.emitObservedStateChanged({
      source: 'device_update',
      deviceId: 'dev-3',
    });
    emitter.emitObservedControlStateChanged({
      deviceId: 'dev-3',
    });

    expect(observedListener).toHaveBeenCalledTimes(1);
    expect(reconcileListener).toHaveBeenCalledTimes(1);
  });

  it('keeps the observed-state and observed-control-state-changed channels independent', () => {
    const emitter = new ObservedStateEmitter();
    const observedListener = vi.fn();
    const reconcileListener = vi.fn();
    emitter.onObservedStateChanged(observedListener);
    emitter.onObservedControlStateChanged(reconcileListener);

    emitter.emitObservedStateChanged({
      source: 'realtime_capability',
      deviceId: 'dev-4',
    });

    expect(observedListener).toHaveBeenCalledTimes(1);
    expect(reconcileListener).not.toHaveBeenCalled();
  });

  it('routes generation reports through the dispatcher into the observer holder', () => {
    // Transport pushes the Homey-SDK-sourced generation scalar via the
    // dispatcher; observer's `ObservedHomePower` holder owns the read.
    const emitter = new ObservedStateEmitter();
    const homePower = new ObservedHomePower();
    const dispatcher = emitter.asDispatcher(homePower);

    expect(homePower.getGenerationW()).toBeNull();
    expect(homePower.getGenerationObservedAtMs()).toBeNull();

    dispatcher.setGenerationW(2400, 1_000);
    expect(homePower.getGenerationW()).toBe(2400);
    expect(homePower.getGenerationObservedAtMs()).toBe(1_000);
  });
});

describe('ObservedHomePower', () => {
  it('returns null before any report is pushed', () => {
    const homePower = new ObservedHomePower();
    expect(homePower.getGenerationW()).toBeNull();
    expect(homePower.getGenerationObservedAtMs()).toBeNull();
  });

  it('returns the last pushed reading and its read time', () => {
    const homePower = new ObservedHomePower();
    homePower.setGenerationW(1500, 1_000);
    expect(homePower.getGenerationW()).toBe(1500);
    expect(homePower.getGenerationObservedAtMs()).toBe(1_000);
    homePower.setGenerationW(3200, 2_000);
    expect(homePower.getGenerationW()).toBe(3200);
    expect(homePower.getGenerationObservedAtMs()).toBe(2_000);
  });

  it('keeps the read time when the value is a null observation', () => {
    // "The report carried no generation" is itself an observation: the VALUE
    // clears but the TIMESTAMP advances.
    const homePower = new ObservedHomePower();
    homePower.setGenerationW(800, 1_000);
    homePower.setGenerationW(null, 2_000);
    expect(homePower.getGenerationW()).toBeNull();
    expect(homePower.getGenerationObservedAtMs()).toBe(2_000);
  });
});
