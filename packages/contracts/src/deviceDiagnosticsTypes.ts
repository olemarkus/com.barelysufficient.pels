export type DeviceDiagnosticsWindowKey = '1d' | '7d' | '21d';

// Why the starvation clock is RUNNING. Mirrors `PlanStarvationCountingCause`
// (`lib/planContract/planDecisionSemantics.ts`), which is the only producer of the
// planner-derived members; the rule for membership is "PELS is the reason the device is
// down" (`notes/starvation/README.md`). Each cause stays distinct because device detail
// renders it — a cooldown must not read as a reservation.
export type DeviceDiagnosticsStarvationCountingCause =
  | 'capacity'
  | 'daily_budget'
  | 'hourly_budget'
  | 'shortfall'
  | 'swap_pending'
  | 'swapped_out'
  | 'insufficient_headroom'
  | 'shedding_active'
  | 'cooldown'
  | 'restore'
  | 'restore_throttled'
  | 'activation_backoff'
  | 'reserved_for_start';

// Why the starvation clock is STOPPED. Two producers: the planner classifier for the holds
// PELS did not impose (`keep`, `inactive`, `restore`) and the two the owner asked for
// (`deferred_objective_avoid`, `awaiting_solar_surplus`), and the episode tracker
// (`lib/diagnostics/deviceDiagnosticsEpisodes.ts`) for the observation-quality ones.
export type DeviceDiagnosticsStarvationPauseReason =
  | 'inactive'
  | 'keep'
  | 'restore'
  | 'suppression_none'
  | 'invalid_observation'
  | 'sample_gap'
  | 'deferred_objective_avoid'
  | 'awaiting_solar_surplus'
  | 'unknown_suppression_reason';

export type DeviceDiagnosticsWindowSummary = {
  unmetDemandMs: number;
  blockedByHeadroomMs: number;
  blockedByCooldownBackoffMs: number;
  targetDeficitMs: number;
  shedCount: number;
  restoreCount: number;
  failedActivationCount: number;
  stableActivationCount: number;
  penaltyBumpCount: number;
  maxPenaltyLevelSeen: number;
  avgShedToRestoreMs: number | null;
  avgRestoreToSetbackMs: number | null;
  minRestoreToSetbackMs: number | null;
  maxRestoreToSetbackMs: number | null;
};

export type DeviceDiagnosticsStarvationSummary = {
  isStarved: boolean;
  starvedAccumulatedMs: number;
  starvationEpisodeStartedAt: number | null;
  starvationLastResumedAt: number | null;
  intendedNormalTargetC: number | null;
  currentTemperatureC: number | null;
  starvationCause: DeviceDiagnosticsStarvationCountingCause | null;
  starvationPauseReason: DeviceDiagnosticsStarvationPauseReason | null;
};

export type DeviceDiagnosticsSummary = {
  currentPenaltyLevel: number;
  starvation: DeviceDiagnosticsStarvationSummary;
  windows: Record<DeviceDiagnosticsWindowKey, DeviceDiagnosticsWindowSummary>;
};

export type SettingsUiDeviceDiagnosticsPayload = {
  generatedAt: number | null;
  windowDays: number;
  diagnosticsByDeviceId: Record<string, DeviceDiagnosticsSummary>;
};
