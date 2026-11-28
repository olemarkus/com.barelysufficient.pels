import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { DeyeCloudCredentials } from '../actuator/deyeCloudClient';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';

export const DEYE_DISCHARGE_HOLD_KEY = 'deye_discharge_hold';

const STEPS_WITHOUT_ORDER = ['held', 'restore_needed', 'unreadable_order', 'unexpected_limit'] as const;

export type DeyeClaimStep =
  | { kind: 'submitting'; direction: 'hold' | 'restore' }
  | { kind: 'order' | 'readback'; direction: 'hold' | 'restore'; orderId: string; sinceMs: number }
  | { kind: typeof STEPS_WITHOUT_ORDER[number] };

export type DeyeClaim = {
  originalLimitA: number;
  releaseRequestedAtMs?: number;
  step: DeyeClaimStep;
};

export type DeyeHoldRecord = {
  enabled: boolean;
  credentials: DeyeCloudCredentials;
  claim?: DeyeClaim;
};

export type DeyeHoldSettings = Pick<SettingsPort, 'get' | 'getKeys' | 'set' | 'unset'>;

export const deyeText = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() && value.length <= 512 ? value.trim() : undefined
);

export const deyeRegion = (value: unknown): DeyeCloudCredentials['region'] | undefined => (
  value === 'eu' || value === 'am' || value === 'india' ? value : undefined
);

function readCredentials(value: unknown): DeyeCloudCredentials | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const region = deyeRegion(value.region);
  const appId = deyeText(value.appId);
  const appSecret = deyeText(value.appSecret);
  const email = deyeText(value.email);
  const deviceSn = deyeText(value.deviceSn);
  const { passwordHash } = value;
  if (!region || !appId || !appSecret || !email || !deviceSn
    || typeof passwordHash !== 'string' || !/^[a-f0-9]{64}$/u.test(passwordHash)) return undefined;
  return { region, appId, appSecret, email, deviceSn, passwordHash };
}

function readStep(value: unknown): DeyeClaimStep | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const { kind, direction, orderId, sinceMs } = value;
  const stepWithoutOrder = STEPS_WITHOUT_ORDER.find((name) => name === kind);
  if (stepWithoutOrder) return { kind: stepWithoutOrder };
  if (direction !== 'hold' && direction !== 'restore') return undefined;
  if (kind === 'submitting') return { kind, direction };
  if ((kind !== 'order' && kind !== 'readback') || typeof orderId !== 'string' || !/^[1-9]\d{0,18}$/u.test(orderId)
    || typeof sinceMs !== 'number' || !Number.isSafeInteger(sinceMs) || sinceMs < 0) return undefined;
  return { kind, direction, orderId, sinceMs };
}

function readClaim(value: unknown): DeyeClaim | undefined {
  if (!isUnknownRecord(value)) return undefined;
  const { originalLimitA, releaseRequestedAtMs } = value;
  if (typeof originalLimitA !== 'number' || !Number.isSafeInteger(originalLimitA) || originalLimitA <= 0) {
    return undefined;
  }
  const step = readStep(value.step);
  if (!step) return { originalLimitA, step: { kind: 'unreadable_order' } };
  if (releaseRequestedAtMs === undefined) return { originalLimitA, step };
  if (typeof releaseRequestedAtMs !== 'number' || !Number.isSafeInteger(releaseRequestedAtMs)
    || releaseRequestedAtMs < 0) return { originalLimitA, step: { kind: 'unreadable_order' } };
  return { originalLimitA, step, releaseRequestedAtMs };
}

/** null is a never-written configuration; undefined is an unreadable record. */
export function readDeyeHoldRecord(settings: DeyeHoldSettings): DeyeHoldRecord | null | undefined {
  const keys = readSettingsKeyList(settings);
  if (keys.status !== 'resolved') return undefined;
  if (!keys.keys.includes(DEYE_DISCHARGE_HOLD_KEY)) return null;
  try {
    const value = settings.get(DEYE_DISCHARGE_HOLD_KEY);
    if (!isUnknownRecord(value) || typeof value.enabled !== 'boolean') return undefined;
    const credentials = readCredentials(value.credentials);
    const claim = readClaim(value.claim);
    if (!credentials || (value.claim !== undefined && !claim)) return undefined;
    return { enabled: value.enabled, credentials, ...(claim ? { claim } : {}) };
  } catch {
    return undefined;
  }
}
