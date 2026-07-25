import type { ZoneTree } from './managerZones';

/**
 * Leaf-owned zone-tree cache with the fetch-generation guard.
 *
 * The transport refreshes the tree co-temporally with the device snapshot but
 * DETACHED from it (fire-and-forget), so two close refresh cycles' fetches can
 * resolve out of order. Each fetch bumps + captures a generation at invocation
 * and may commit only if newer than the LAST COMMITTED generation
 * (`snapshotRefresh.ts` `refreshZoneTreeCache`) — an older cycle's slow
 * response can never overwrite a newer cycle's committed tree, while a
 * superseded-but-fresher-than-cache result still lands when the newer fetch
 * failed and committed nothing. A failed fetch commits nothing, so the cached
 * tree survives (abandon-grace).
 */
export class ZoneTreeCache {
  private tree: ZoneTree | null = null;
  private generation = 0;
  private lastCommittedGeneration = 0;

  /** Latest successfully committed tree; `null` until the first commit. */
  get(): ZoneTree | null {
    return this.tree;
  }

  /** Whole-tree last-writer-wins replacement — successful fetches only. */
  set(tree: ZoneTree, generation: number): void {
    this.tree = tree;
    this.lastCommittedGeneration = generation;
  }

  /** Start a new fetch: bump the generation and capture it for the guard. */
  bumpGeneration(): number {
    this.generation += 1;
    return this.generation;
  }

  getLastCommittedGeneration(): number {
    return this.lastCommittedGeneration;
  }
}
