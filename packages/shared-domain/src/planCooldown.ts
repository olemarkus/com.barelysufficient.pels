import type { SettingsUiPlanDeviceSnapshot } from '../../contracts/src/settingsUiApi.js';
import { PLAN_REASON_CODES } from './planReasonSemanticsCore.js';

type CooldownDevice = Pick<SettingsUiPlanDeviceSnapshot, 'reason'>;

// Canonical cooldown durations, in seconds. Used as the denominator for the
// ring animation so a given `remainingSec` always maps to the same fill ratio
// across re-renders and page reloads. Values mirror the runtime defaults in
// lib/plan/planRestoreTiming.ts and docs/technical.md. Exponential backoff on
// restore means the actual base may be smaller; the ring simply starts at a
// partial fill in that case, which is acceptable.
const COOLDOWN_BASE_SEC: Record<string, number> = {
  [PLAN_REASON_CODES.cooldownShedding]: 60,
  [PLAN_REASON_CODES.cooldownRestore]: 300,
  [PLAN_REASON_CODES.meterSettling]: 10,
  [PLAN_REASON_CODES.activationBackoff]: 60,
  [PLAN_REASON_CODES.restorePending]: 60,
  [PLAN_REASON_CODES.headroomCooldown]: 300,
};

const readReasonCode = (reason: unknown): string | null => {
  if (!reason || typeof reason !== 'object') return null;
  const value = (reason as { code?: unknown }).code;
  return typeof value === 'string' ? value : null;
};

const readRemainingSec = (reason: unknown): number | null => {
  if (!reason || typeof reason !== 'object') return null;
  const value = (reason as { remainingSec?: unknown }).remainingSec;
  return typeof value === 'number' && value > 0 ? value : null;
};

export const resolveCooldownBaseSec = (device: CooldownDevice): number | null => {
  const code = readReasonCode(device.reason);
  if (code !== null && code in COOLDOWN_BASE_SEC) return COOLDOWN_BASE_SEC[code];
  const reasonSec = readRemainingSec(device.reason);
  if (reasonSec !== null) return Math.max(1, reasonSec);
  return null;
};

export const resolveCooldownRemainingSec = (device: CooldownDevice): number | null => {
  const reasonSec = readRemainingSec(device.reason);
  if (reasonSec !== null) return Math.max(0, reasonSec);
  return null;
};

export const hasActiveCooldown = (device: CooldownDevice): boolean => (
  resolveCooldownBaseSec(device) !== null
);

export const summarizeCooldowns = (
  devices: Array<CooldownDevice> | null | undefined,
): string | null => {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  const count = devices.filter(hasActiveCooldown).length;
  if (count === 0) return null;
  return count === 1 ? '1 cooling down' : `${count} cooling down`;
};
