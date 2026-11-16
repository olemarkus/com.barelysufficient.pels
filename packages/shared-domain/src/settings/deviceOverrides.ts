/**
 * The stored shape of a device override: one setting PELS holds on one device
 * until a stated time, in place of what it would otherwise decide. Shared by the
 * settings UI, which writes it, and the runtime owner
 * (`lib/overrides/deviceOverrides.ts`), which decides when it is in force.
 *
 * One key per device, `device_override.<deviceId>`. A new kind of override is a
 * new member of {@link DeviceOverrideSetting}.
 */
export const DEVICE_OVERRIDE_PREFIX = 'device_override.';

/** The furthest end time an override may be given: seven days ahead. */
export const MAX_DEVICE_OVERRIDE_MINUTES = 7 * 24 * 60;

export type DeviceOverrideSetting = { type: 'temperature'; targetC: number };

export type DeviceOverride = {
  /** When it ends. An end time at or before now is how an override is ended early. */
  untilMs: number;
  setting: DeviceOverrideSetting;
};

export const deviceOverrideKey = (deviceId: string): string => `${DEVICE_OVERRIDE_PREFIX}${deviceId}`;

export const isDeviceOverrideKey = (key: string): boolean => (
  key.startsWith(DEVICE_OVERRIDE_PREFIX) && key.length > DEVICE_OVERRIDE_PREFIX.length
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const parseSetting = (raw: unknown): DeviceOverrideSetting | null => {
  if (!isRecord(raw) || raw.type !== 'temperature') return null;
  const { targetC } = raw;
  return typeof targetC === 'number' && Number.isFinite(targetC) ? { type: 'temperature', targetC } : null;
};

/** In force while its end is ahead, and no further ahead than the maximum. */
export const isDeviceOverrideInForce = (override: DeviceOverride, nowMs: number): boolean => (
  override.untilMs > nowMs && override.untilMs - nowMs <= MAX_DEVICE_OVERRIDE_MINUTES * 60_000
);

/** `null` for anything that is not a well-formed override. */
export const parseDeviceOverride = (raw: unknown): DeviceOverride | null => {
  if (!isRecord(raw)) return null;
  const { untilMs } = raw;
  if (typeof untilMs !== 'number' || !Number.isFinite(untilMs)) return null;
  const setting = parseSetting(raw.setting);
  return setting ? { untilMs, setting } : null;
};
