import type { ZoneTree } from './managerZones';
import type { TargetedMissState } from './targetedSnapshotMerge';
import { ZoneTreeCache } from './zoneTreeCache';

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

  lastCommittedZoneTreeGeneration(): number {
    return this.zoneTree.getLastCommittedGeneration();
  }
}
