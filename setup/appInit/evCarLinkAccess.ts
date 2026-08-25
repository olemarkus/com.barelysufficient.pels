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
import type { TimerRegistry } from '../../lib/utils/timerRegistry';
import {
  loadEvCarLinkStore,
  persistEvCarLinkFlush,
  persistEvCarLinkIfDue,
  type EvCarLinkStore,
} from '../../lib/device/evCarLinkStore';

/**
 * Cadence of the persist guard — slightly above the store's 60 s persist
 * debounce so a tick landing one debounce after a successful write is not
 * knife-edged out by the few milliseconds the write itself took (which would
 * silently double the effective retry latency).
 */
const EV_CAR_LINK_PERSIST_GUARD_INTERVAL_MS = 65 * 1000;

export const createPersistedEvCarLinkAccess = (
  homey: HomeyRuntime,
  timers: TimerRegistry,
): EvCarLinkSnapshotAccess => {
  let store: EvCarLinkStore | undefined;
  const resolve = (): EvCarLinkStore => {
    if (store === undefined) {
      const loaded = loadEvCarLinkStore({ homey });
      store = loaded;
      // Persist guard, started with the store because nothing else retries:
      // a vote accepted inside the debounce, or a failed write, otherwise
      // sits memory-only until the next mutation or shutdown — and PELS is
      // routinely OOM-killed before the shutdown flush runs. The tick is an
      // isDirty() no-op when there is nothing to write, and the registry
      // clears it on app teardown.
      timers.registerInterval('evCarLinkPersistGuard', setInterval(
        () => persistEvCarLinkIfDue({ homey, store: loaded, nowMs: Date.now() }),
        EV_CAR_LINK_PERSIST_GUARD_INTERVAL_MS,
      ));
    }
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
