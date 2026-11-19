/** An old battery claim whose original control target needs the owner's confirmation. */
export type BatteryRecovery = {
  claimedAtMs: number;
  candidates: readonly BatteryRecoveryCandidate[];
};

export type BatteryRecoveryCandidate = { id: string; name: string };

export type BatteryRecoveryRequest = { claimedAtMs: number } & (
  | { action: 'hand_back'; targetId: string }
  | { action: 'acknowledge' }
);

export const BATTERY_RECOVERY_PATH = '/ui_battery_recovery';
