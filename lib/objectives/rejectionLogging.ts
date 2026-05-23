const OBJECTIVE_PROFILE_REJECTION_LOG_THROTTLE_MS = 15 * 60 * 1000;
const ROUTINE_PROFILE_REJECTION_REASONS = new Set([
  'objective_profile_rise_too_small',
  'objective_profile_value_fell',
]);
const rejectedProfileLogTimes = new Map<string, number>();

export function shouldEmitRejectedProfileSample(params: {
  deviceId?: string;
  rejectionReason: string;
}): boolean {
  const { deviceId, rejectionReason } = params;
  if (!deviceId) return true;
  const key = ROUTINE_PROFILE_REJECTION_REASONS.has(rejectionReason)
    ? `routine:${rejectionReason}`
    : `${deviceId}:${rejectionReason}`;
  const nowMs = Date.now();
  const previousLogAtMs = rejectedProfileLogTimes.get(key);
  if (
    previousLogAtMs !== undefined
    && nowMs - previousLogAtMs < OBJECTIVE_PROFILE_REJECTION_LOG_THROTTLE_MS
  ) {
    return false;
  }
  rejectedProfileLogTimes.set(key, nowMs);
  return true;
}
