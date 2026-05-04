import type {
  TargetPowerSteppedLoadConfig,
  TargetPowerSteppedLoadPreset,
} from './types';

type UnknownRecord = Record<string, unknown>;

export function normalizeTargetPowerSteppedLoadConfig(
  value: unknown,
): TargetPowerSteppedLoadConfig | undefined {
  const parsed = parseJsonObject(value);
  if (!parsed) return undefined;

  const preset = normalizePreset(parsed.preset);
  const min = normalizeFiniteNumber(parsed.min);
  const max = normalizeFiniteNumber(parsed.max);
  const step = normalizeFiniteNumber(parsed.step);
  const excludeMin = normalizeFiniteNumber(parsed.excludeMin);
  const excludeMax = normalizeFiniteNumber(parsed.excludeMax);
  const enabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined;
  const config: TargetPowerSteppedLoadConfig = {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(preset ? { preset } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(excludeMin !== undefined ? { excludeMin } : {}),
    ...(excludeMax !== undefined ? { excludeMax } : {}),
  };
  if (Object.keys(config).length === 0) return undefined;
  if (config.enabled === false) return config;
  if (config.preset || (config.max !== undefined && config.step !== undefined)) return config;
  return undefined;
}

export function normalizeDeviceTargetPowerConfigs(
  value: unknown,
): Record<string, TargetPowerSteppedLoadConfig> {
  const record = parseJsonObject(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).flatMap(([deviceId, entry]) => {
      const normalizedId = deviceId.trim();
      const config = normalizeTargetPowerSteppedLoadConfig(entry);
      return normalizedId && config ? [[normalizedId, config]] : [];
    }),
  );
}

function parseJsonObject(value: unknown): UnknownRecord | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as UnknownRecord;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as UnknownRecord
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizePreset(value: unknown): TargetPowerSteppedLoadPreset | undefined {
  return value === 'ev_charger_1_phase' || value === 'ev_charger_3_phase'
    ? value
    : undefined;
}
