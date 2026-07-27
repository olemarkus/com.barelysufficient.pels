/**
 * Settings-backed owner of the EV car-link probe's persisted state.
 *
 * Lives in `setup/` because constructing a concrete Homey-settings adapter and
 * owning its load/persist/flush lifecycle is app wiring, not domain logic. The
 * device layer declares the port it needs ({@link EvCarLinkSnapshotAccess}) and
 * receives an implementation; it must not reach for the runtime settings port
 * itself, which would invert the boundary this layer exists to hold.
 *
 * The store is loaded on FIRST USE, not here: a probe must never be able to fail
 * app boot on a settings read, and a home with no car never touches it at all.
 */
import type { HomeyRuntime } from '../../lib/ports/homeyRuntime';
import type { EvCarLinkSnapshotAccess } from '../../lib/device/evCarLinkWiring';
import {
  loadEvCarLinkStore,
  persistEvCarLinkFlush,
  persistEvCarLinkIfDue,
  type EvCarLinkStore,
} from '../../lib/device/evCarLinkStore';

export const createPersistedEvCarLinkAccess = (homey: HomeyRuntime): EvCarLinkSnapshotAccess => {
  let store: EvCarLinkStore | undefined;
  const resolve = (): EvCarLinkStore => {
    store ??= loadEvCarLinkStore({ homey });
    return store;
  };
  return {
    get: () => resolve().getSnapshot(),
    set: (snapshot) => {
      const active = resolve();
      active.setSnapshot(snapshot);
      // Debounce + load-grace gated inside the store, so this is safe on every
      // accepted vote rather than needing its own timer.
      persistEvCarLinkIfDue({ homey, store: active, nowMs: Date.now() });
    },
    // No-op when nothing ever loaded the store — there is nothing buffered.
    flush: () => { if (store) persistEvCarLinkFlush({ homey, store, nowMs: Date.now() }); },
  };
};
