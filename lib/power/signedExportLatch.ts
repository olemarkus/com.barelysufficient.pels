import type { SettingsPort } from '../ports/homeyRuntime';
import type { PowerTrackerState } from './trackerTypes';
import { SIGNED_EXPORT_OBSERVED } from '../utils/settingsKeys';
import { hasRecordedAnyExport } from '../../packages/shared-domain/src/solar/exhibitedExport';

/**
 * Has this home's whole-home feed ever expressed grid export? Owner of the
 * `signed_export_observed` key (`notes/settings-key-ownership.md`), a
 * runtime-only latch.
 *
 * The answer is one half of `resolveSurplusPoolReachable`, which gates the
 * standing `surplusOnly` posture of an opted-in dump load. It used to be read
 * straight off the tracker's export families — accounting history, which the
 * owner can wipe ("Reset usage history") and retention prunes after 30/365
 * days. Either one silently turned a signed-net home's pool "unreachable", the
 * dump load lost its stamp, and the generic managed-binary restore lane then
 * ran it from the grid. On a home whose dump load draws more than its PV
 * surplus, the load itself keeps net non-negative and the evidence never comes
 * back.
 *
 * The capability is a fact about the feed, not about the history: once net has
 * gone negative, the feed CAN express export. So it is a monotone bit — armed
 * once, never cleared by a reset or a prune — like the curtailment estimator's
 * armed latch (`CurtailmentPersistedHoldState.armed`), which answers the other
 * half of the same predicate.
 *
 * Not cleared when the feed itself changes (a power-source or Main-meter
 * switch) either. A home that moves to a feed which can no longer go negative
 * keeps the answer, so an opted-in dump load there stays held off until the
 * owner turns "Use solar surplus" off — which they can, because that toggle is
 * gated on this same answer and so stays visible.
 *
 * Stored in `homey.settings` rather than the userdata store because it is a
 * small, mission-critical latch written once in the home's life — not history.
 *
 * Two sides, deliberately split: the tracker component {@link observe}s every
 * state it adopts, which is where the evidence appears and where the one write
 * happens; {@link readEvidence} is a read, safe on the plan path and in a
 * UI request.
 */
/**
 * What the latch knows about the feed:
 *
 * - `expressed` — armed, in memory or on disk.
 * - `none` — settled: the store holds no bit and this run has seen no export.
 * - `unreadable` — the stored bit could not be read (a thrown read, an empty
 *   key list, a listed key that reads back empty) and this run has seen no
 *   export. NOT `none`: after a reset the stored bit is the only evidence
 *   left, so a transient miss must not be reported as "never exported". What
 *   it means for control is the reachability policy's call
 *   (`resolveSurplusPoolReachable`).
 */
export type FeedExportEvidence = 'expressed' | 'none' | 'unreadable';

export class SignedExportLatch {
  private armed = false;

  /**
   * Whether the stored bit still has to be read. Stays owed after a read that
   * settles nothing — a thrown read, an empty or malformed key list, or a key
   * the list vouches for that reads back empty — so a transient miss is asked
   * again rather than settled as "never observed"
   * (`notes/persisted-settings-state.md`: an empty `getKeys()` is a flake).
   */
  private readOwed = true;

  /** Armed in memory, not yet on disk. Retried on the next observation. */
  private writeOwed = false;

  constructor(private readonly settings: SettingsPort) {}

  /**
   * Arm from `tracker` the first time it shows recorded export, and persist.
   *
   * Arming from the tracker's recorded export (`hasRecordedAnyExport`) rather
   * than from a raw negative sample means a home upgrading with export already
   * in its history is armed when its stored tracker is hydrated, before any
   * reset can take that evidence away. Deliberately NOT the 1 kWh materiality
   * floor: the question is whether the feed can express export at all, which
   * one negative sample settles.
   */
  observe(tracker: PowerTrackerState): void {
    if (!this.armed && hasRecordedAnyExport(tracker)) {
      this.armed = true;
      this.writeOwed = true;
    }
    if (this.writeOwed) this.persist();
  }

  /** The latched answer: armed in memory, or stored by an earlier run. */
  readEvidence(): FeedExportEvidence {
    if (!this.armed && this.readOwed) this.readStore();
    if (this.armed) return 'expressed';
    return this.readOwed ? 'unreadable' : 'none';
  }

  private readStore(): void {
    try {
      const stored = this.settings.get(SIGNED_EXPORT_OBSERVED);
      if (stored === true) {
        this.armed = true;
        this.readOwed = false;
        return;
      }
      // A present value that is not `true` came from outside PELS (this module
      // only ever writes `true`). It is not transient, so it settles as
      // unarmed rather than being re-read on every question; arming writes
      // `true` over it, which a monotone bit can always do.
      if (stored !== undefined && stored !== null) {
        this.readOwed = false;
        return;
      }
      if (listsKeysWithout(this.settings.getKeys(), SIGNED_EXPORT_OBSERVED)) this.readOwed = false;
    } catch {
      // The store could not answer. Nothing is settled; the next question asks again.
    }
  }

  /**
   * Best-effort write. The bit is monotone, so writing `true` over an
   * unreadable or foreign value can never destroy anything.
   */
  private persist(): void {
    try {
      this.settings.set(SIGNED_EXPORT_OBSERVED, true);
      this.writeOwed = false;
      this.readOwed = false;
    } catch {
      // Still owed: the next observation retries. Memory already answers true.
    }
  }
}

/**
 * Only a non-empty, well-formed key list that lacks the key proves it was never
 * written. An empty list is a flake of this platform, not an empty store.
 */
const listsKeysWithout = (keys: unknown, key: string): boolean => (
  Array.isArray(keys)
  && keys.length > 0
  && keys.every((listed): listed is string => typeof listed === 'string')
  && !keys.includes(key)
);
