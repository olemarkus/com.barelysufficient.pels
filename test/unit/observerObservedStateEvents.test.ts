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
import { type TransportObservedStateDispatcher } from '../../lib/device/deviceTransport';

// ---------- compile-time shape-parity guard ----------
// Observer's `ObservedStateEmitterDispatcher` and transport's
// `TransportObservedStateDispatcher` are structurally mirrored by hand because
// the cruiser correctly blocks both directions of import between `lib/device/`
// and `lib/observer/`. Wiring passes the observer dispatcher into transport's
// slot, and TypeScript's bivariance bridges the two — so a member added, dropped
// or re-shaped on one side alone still typechecks at the binding site and routes
// the wrong shape at runtime. The assertion below fails compilation instead, and
// two details in it are load-bearing.
//
// The operands are wrapped in tuples. A NAKED type parameter on the left of
// `extends` DISTRIBUTES over a union, so an optional member — `F | undefined` —
// evaluates element-wise to `true | false`, which is `boolean`, and `[true, true]`
// is happily assignable to `[true, boolean]`. Written that way the guard passes on
// exactly the divergence it exists to catch. `[B] extends [A]` does not distribute.
//
// It compares the WHOLE dispatcher types rather than a list of members. A
// per-member assertion can only police members someone remembered to list, and a
// member present on one side alone is invisible to every one of them — which is
// how transport's copy of `externalTemperatureAdjusted` stayed `?:` for a whole
// train while observer's was required and `asDispatcher` always supplied it.
type _MutuallyAssignable<A, B> = [
  [A] extends [B] ? true : false,
  [B] extends [A] ? true : false,
];

const _dispatcherParity: _MutuallyAssignable<
  ObservedStateEmitterDispatcher,
  TransportObservedStateDispatcher
> = [true, true];

// Reference the value so the compiler doesn't strip it as unused.
void _dispatcherParity;

describe('ObservedStateEmitter', () => {
  it('pins the event-name strings this emitter routes on', () => {
    // These literals are the channel names on observer's EventEmitter, and
    // since transport's fallback emit path was deleted they are the only
    // declaration of them. They are NOT log fields — grep finds them nowhere
    // else, which is why `plan_reconcile_realtime_update` could be renamed with
    // the lane it was named after (root `AGENTS.md` § Control Flow).
    expect(OBSERVED_STATE_CHANGED_EVENT).toBe('plan_live_state_observed');
    expect(OBSERVED_CONTROL_STATE_CHANGED_EVENT).toBe('observed_control_state_changed');
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
