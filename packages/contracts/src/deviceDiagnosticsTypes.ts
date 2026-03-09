export type DeviceDiagnosticsWindowKey = '1d' | '7d' | '21d';

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

export type DeviceDiagnosticsSummary = {
  currentPenaltyLevel: number;
  windows: Record<DeviceDiagnosticsWindowKey, DeviceDiagnosticsWindowSummary>;
};

export type SettingsUiDeviceDiagnosticsPayload = {
  generatedAt: number | null;
  windowDays: number;
  diagnosticsByDeviceId: Record<string, DeviceDiagnosticsSummary>;
};
