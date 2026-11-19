/** An explicit recovery command; the runtime fetches and owns all historical data. */
export const POWER_HISTORY_RECOVERY_REQUEST = 'power_history_recovery_request';

export function readPowerHistoryRecoveryRequest(raw: unknown): { id: string } | null {
  if (typeof raw !== 'object' || raw === null || !('id' in raw)) return null;
  return typeof raw.id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.id)
    ? { id: raw.id } : null;
}
