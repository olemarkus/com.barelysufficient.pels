/**
 * Construct a `DeviceTransport` the way production does — with an
 * observer-owned `ObservedStateEmitter` injected — and subscribe to it through
 * that emitter.
 *
 * Why this exists. Transport used to extend `EventEmitter` and fall back to
 * `this.emit(...)` when no `observedStateDispatcher` was injected. Production
 * always injects one (`setup/appInit/wireDeviceTransport.ts`), so that fallback
 * had ZERO production subscribers: every subscription was a spec. It was a
 * second, untyped event surface shadowing the emitter the observer/transport
 * split made canonical — a reader could not tell from `DeviceTransport` alone
 * which one carried the events.
 *
 * Deleting it meant making the dispatcher non-optional, which meant making
 * `options` non-optional, which put every `new DeviceTransport(` site in the
 * blast radius. This file absorbs that: a spec calls
 * `createTestDeviceTransport(...)` with the same positional arguments it used
 * before, and subscribes with `onObservedControlState(transport, fn)` instead of
 * `transport.on(OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT, fn)`. Same event,
 * same payload, delivered by the emitter.
 *
 * The transport→emitter association is held in a `WeakMap` rather than returned,
 * so a subscribing spec needs no different construction from a non-subscribing
 * one — and so migrating one is a local edit at the subscription, not a rewrite
 * of the test's setup.
 */
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { createRetainedPowerStore } from '../../lib/device/retainedPowerStore';
import { vi } from 'vitest';
import { DeviceTransport } from '../../lib/device/deviceTransport';
import type { TransportObservedStateDispatcher } from '../../lib/device/deviceTransport';
import { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import { ObservedHomePower } from '../../lib/observer/observedHomePower';
import type {
  ObservedControlStateChangedEvent,
  ObservedStateChangedEvent,
} from '../../lib/observer/observedStateEvents';

type TransportArgs = ConstructorParameters<typeof DeviceTransport>;

const emitterByTransport = new WeakMap<DeviceTransport, ObservedStateEmitter>();

/**
 * A fully-populated dispatcher of spies, for the specs that assert on the
 * dispatcher itself rather than on delivered events. Every member is present,
 * so adding one to `TransportObservedStateDispatcher` is a one-line edit here
 * instead of an edit in each spec that stubs it — which is how the mirror's
 * `externalTemperatureAdjusted` could stay optional while observer's side had
 * always been required.
 */
export const createTestObservedStateDispatcher = (
  overrides: Partial<TransportObservedStateDispatcher> = {},
): TransportObservedStateDispatcher => ({
  observedStateChanged: vi.fn(),
  observedStateRefresh: vi.fn(),
  observedControlStateChanged: vi.fn(),
  externalTemperatureAdjusted: vi.fn(),
  setGenerationW: vi.fn(),
  ...overrides,
});

/**
 * Same positional arguments as the constructor, so a migrating spec keeps its
 * providers/powerState/options exactly as they were. An `observedStateDispatcher`
 * the caller passes wins — a spec asserting on the dispatcher itself keeps doing
 * that, it just cannot then use the subscribe helpers below.
 *
 * That exclusion is enforced, not merely documented: when the caller injects a
 * dispatcher the transport dispatches nowhere near our emitter, so registering
 * it would let `onObservedState(transport, fn)` subscribe to an emitter nothing
 * reaches — a spec that asserts nothing and passes. Leaving it unregistered
 * turns that into the error from `emitterFor`.
 */
export function createTestDeviceTransport(
  homey: TransportArgs[0],
  logger: TransportArgs[1],
  providers?: TransportArgs[2],
  powerState?: TransportArgs[3],
  options?: Partial<TransportArgs[4]>,
): DeviceTransport {
  // One read of the caller's dispatcher decides both branches. Spreading
  // `options` over a default instead would let an explicit
  // `observedStateDispatcher: undefined` blank the dispatcher while still
  // reading as "caller injected nothing" — a transport that throws on its first
  // dispatch AND a subscribe helper attached to an emitter nothing reaches.
  const { observedStateDispatcher: injected, retainedPowerStore, ...rest } = options ?? {};
  // A fresh in-memory store per transport unless the spec passes one: a spec
  // that restarts a transport on the same store is how a restart is modelled.
  const store = retainedPowerStore ?? createRetainedPowerStore(openUserdataDatabase(IN_MEMORY_DATABASE));
  if (injected) {
    return new DeviceTransport(homey, logger, providers, powerState, {
      ...rest, observedStateDispatcher: injected, retainedPowerStore: store,
    });
  }
  const emitter = new ObservedStateEmitter();
  const transport = new DeviceTransport(homey, logger, providers, powerState, {
    ...rest, observedStateDispatcher: emitter.asDispatcher(new ObservedHomePower()), retainedPowerStore: store,
  });
  emitterByTransport.set(transport, emitter);
  return transport;
}

const emitterFor = (transport: DeviceTransport): ObservedStateEmitter => {
  const emitter = emitterByTransport.get(transport);
  if (!emitter) {
    throw new Error(
      'This transport was not built by createTestDeviceTransport, so it has no emitter to '
      + 'subscribe to. Build it with the harness, or subscribe to the dispatcher you injected.',
    );
  }
  return emitter;
};

/** Per-capability observed deltas (was `PLAN_LIVE_STATE_OBSERVED_EVENT`). */
export const onObservedState = (
  transport: DeviceTransport,
  listener: (event: ObservedStateChangedEvent) => void,
): void => { emitterFor(transport).onObservedStateChanged(listener); };

/** Control-state changes (was `OBSERVED_CONTROL_STATE_CHANGED_REALTIME_EVENT`). */
export const onObservedControlState = (
  transport: DeviceTransport,
  listener: (event: ObservedControlStateChangedEvent) => void,
): void => { emitterFor(transport).onObservedControlStateChanged(listener); };
