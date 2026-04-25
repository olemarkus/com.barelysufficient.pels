export type DeviceDiagnosticsWindowKey = '1d' | '7d' | '21d';

export type DeviceDiagnosticsStarvationCountingCause =
  | 'capacity'
  | 'daily_budget'
  | 'hourly_budget'
  | 'shortfall'
  | 'swap_pending'
  | 'swapped_out'
  | 'insufficient_headroom'
  | 'shedding_active';

export type DeviceDiagnosticsStarvationPauseReason =
  | 'cooldown'
  | 'headroom_cooldown'
  | 'restore_throttled'
  | 'activation_backoff'
  | 'inactive'
  | 'keep'
  | 'restore'
  | 'suppression_none'
  | 'invalid_observation'
  | 'sample_gap'
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
