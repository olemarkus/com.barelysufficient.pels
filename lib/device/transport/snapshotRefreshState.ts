import type { ZoneTree } from './managerZones';
import type { TargetedMissState } from './targetedSnapshotMerge';
import { ZoneTreeCache } from './zoneTreeCache';

const UNKNOWN_ZONE_REFRESH_MIN_INTERVAL_MS = 10_000;

type EmptySnapshotGrace = {
  firstSeenMs: number;
  reads: number;
};

/** Bookkeeping owned by the snapshot refresh lifecycle. */
export class SnapshotRefreshState {
  private readonly targetedMisses = new Map<string, TargetedMissState>();
  private readonly zoneTree = new ZoneTreeCache();
  private emptySnapshotGrace: EmptySnapshotGrace | null = null;
  private lastRefreshMetricsKey: string | null = null;
  private warm = false;
  private lastUnknownZoneRefreshAtMs = Number.NEGATIVE_INFINITY;

  getTargetedMisses(): Map<string, TargetedMissState> {
    return this.targetedMisses;
  }

  getEmptySnapshotGrace(): EmptySnapshotGrace | null {
    return this.emptySnapshotGrace;
  }

  setEmptySnapshotGrace(grace: EmptySnapshotGrace | null): void {
    this.emptySnapshotGrace = grace;
  }

  hasEmittedMetrics(key: string): boolean {
    if (this.lastRefreshMetricsKey === key) return true;
    this.lastRefreshMetricsKey = key;
    return false;
  }

  isWarm(): boolean {
    return this.warm;
  }

  markWarm(warm: boolean): void {
    this.warm = warm;
  }

  getZoneTree(): ZoneTree | null {
    return this.zoneTree.get();
  }

  beginZoneTreeRefresh(): number {
    return this.zoneTree.bumpGeneration();
  }

  commitZoneTree(tree: ZoneTree, generation: number): boolean {
    if (generation <= this.zoneTree.getLastCommittedGeneration()) return false;
    this.zoneTree.set(tree, generation);
    return true;
  }

  /**
   * Whether an unknown zone may trigger a tree fetch now: at most one per
   * `UNKNOWN_ZONE_REFRESH_MIN_INTERVAL_MS`, so a zone read that keeps failing,
   * or a burst of devices moving at once, cannot turn into a fetch per update.
   */
  claimUnknownZoneRefresh(nowMs: number): boolean {
    if (nowMs - this.lastUnknownZoneRefreshAtMs < UNKNOWN_ZONE_REFRESH_MIN_INTERVAL_MS) return false;
    this.lastUnknownZoneRefreshAtMs = nowMs;
    return true;
  }

  lastCommittedZoneTreeGeneration(): number {
    return this.zoneTree.getLastCommittedGeneration();
  }
}
