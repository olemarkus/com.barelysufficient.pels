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

export function getRecentLocalCapabilityWrite(params: {
  recentLocalCapabilityWrites: RecentLocalCapabilityWrites;
  deviceId: string;
  capabilityId: string;
}): RecentLocalCapabilityWrite | undefined {
  const { recentLocalCapabilityWrites, deviceId, capabilityId } = params;
  const key = buildCapabilityWriteKey(deviceId, capabilityId);
  const entry = recentLocalCapabilityWrites.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    recentLocalCapabilityWrites.delete(key);
    return undefined;
  }
  return entry;
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
