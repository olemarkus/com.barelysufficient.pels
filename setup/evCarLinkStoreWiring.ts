/**
 * App-wiring for the EV car-link probe's persisted state.
 *
 * Holds the store lazily so the transport's construction never depends on a
 * settings read succeeding — a probe must not be able to fail app boot. The
 * store itself (debounce, load-grace, versioned normalisation) lives in
 * `lib/device/evCarLinkStore.ts`; this is only the lifecycle around it.
 */
import type { EvCarLinkSnapshot } from '../packages/contracts/src/evCarLink';
import type { HomeyRuntime } from '../lib/ports/homeyRuntime';
import {
  EvCarLinkStore,
  loadEvCarLinkStore,
  persistEvCarLinkFlush,
  persistEvCarLinkIfDue,
} from '../lib/device/evCarLinkStore';

export class EvCarLinkStoreWiring {
  private store?: EvCarLinkStore;

  /**
   * Takes a getter, not the runtime: this is constructed as a field initializer,
   * where the owning class's own deps are not yet assigned.
   */
  constructor(private readonly getHomey: () => HomeyRuntime) {}

  /**
   * Snapshot accessor handed to `DeviceTransport`. The setter persists through
   * the store's debounce + load-grace gates, so it is safe to call on every
   * accepted vote rather than on a separate timer.
   */
  snapshotAccess(): {
    get: () => EvCarLinkSnapshot;
    set: (snapshot: EvCarLinkSnapshot) => void;
    flush: () => void;
  } {
    return {
      get: () => this.getStore().getSnapshot(),
      set: (snapshot) => {
        const store = this.getStore();
        store.setSnapshot(snapshot);
        persistEvCarLinkIfDue({ homey: this.getHomey(), store, nowMs: Date.now() });
      },
      flush: () => this.flush(),
    };
  }

  /**
   * Shutdown flush. Bypasses the debounce (never the load grace) so votes and
   * observed-stop samples accepted inside the debounce window survive a restart.
   * No-op when the store was never loaded — there is nothing buffered.
   */
  flush(nowMs: number = Date.now()): void {
    if (!this.store) return;
    persistEvCarLinkFlush({ homey: this.getHomey(), store: this.store, nowMs });
  }

  private getStore(): EvCarLinkStore {
    if (!this.store) {
      this.store = loadEvCarLinkStore({ homey: this.getHomey() });
    }
    return this.store;
  }
}
