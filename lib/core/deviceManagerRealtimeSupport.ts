const LOCAL_CAPABILITY_ECHO_SUPPRESS_MS = 5 * 1000;

export type RecentLocalCapabilityWrite = {
  value: unknown;
  expiresAt: number;
};

export type RecentLocalCapabilityWrites = Map<string, RecentLocalCapabilityWrite>;

export function recordLocalCapabilityWrite(params: {
  recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
  deviceId: string;
  capabilityId: string;
  value: unknown;
}): void {
  const { recentLocalCapabilityWrites, deviceId, capabilityId, value } = params;
  recentLocalCapabilityWrites.set(buildCapabilityWriteKey(deviceId, capabilityId), {
    value,
    expiresAt: Date.now() + LOCAL_CAPABILITY_ECHO_SUPPRESS_MS,
  });
}

export function clearLocalCapabilityWrite(params: {
  recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
  deviceId: string;
  capabilityId: string;
}): void {
  const { recentLocalCapabilityWrites, deviceId, capabilityId } = params;
  recentLocalCapabilityWrites.delete(buildCapabilityWriteKey(deviceId, capabilityId));
}

export function consumeMatchingLocalCapabilityWrite(params: {
  recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
  deviceId: string;
  capabilityId: string;
  value: unknown;
}): boolean {
  const { recentLocalCapabilityWrites, deviceId, capabilityId, value } = params;
  const key = buildCapabilityWriteKey(deviceId, capabilityId);
  const entry = recentLocalCapabilityWrites.get(key);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    recentLocalCapabilityWrites.delete(key);
    return false;
  }
  if (!Object.is(entry.value, value)) {
    return false;
  }
  recentLocalCapabilityWrites.delete(key);
  return true;
}

export function formatRealtimeCapabilityValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

export function formatBinaryState(value: boolean | undefined): string {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return 'unknown';
}

export function formatTargetValue(value: unknown, unit?: string | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  return `${value}${unit || ''}`;
}

function buildCapabilityWriteKey(deviceId: string, capabilityId: string): string {
  return `${deviceId}:${capabilityId}`;
}
