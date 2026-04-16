export type PlanRebuildIntent =
  | { kind: 'hardCap'; reason: string }
  | { kind: 'signal'; reason: string }
  | { kind: 'flow'; reason: string }
  | { kind: 'snapshot'; reason: string };

export type PlanRebuildSchedulerState = {
  nowMs: number;
  activeIntent: PlanRebuildIntent | null;
  pendingIntent: PlanRebuildIntent | null;
  pendingDueMs: number | null;
  hasTimer: boolean;
  lastCompletedAtMsByKind: Partial<Record<PlanRebuildIntent['kind'], number>>;
};

export type PlanRebuildSchedulerLike = {
  request(intent: PlanRebuildIntent): void;
  cancelAll(reason: string): void;
  now(): PlanRebuildSchedulerState;
};
