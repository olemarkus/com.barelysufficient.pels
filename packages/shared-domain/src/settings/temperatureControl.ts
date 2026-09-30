/** Per-device temperature authority. Explicit entries override the legacy disable toggle. */
export type TemperatureControlMode = 'mode' | 'external' | 'update_mode';
export type TemperatureControlModes = Record<string, TemperatureControlMode>;

export function readTemperatureControlModes(value: unknown): TemperatureControlModes | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([id, mode]) => id.length > 0
    && (mode === 'mode' || mode === 'external' || mode === 'update_mode'))) return null;
  return Object.fromEntries(entries);
}

export function resolveTemperatureControlMode(
  modes: TemperatureControlModes,
  legacyDisabled: Record<string, boolean>,
  deviceId: string,
): TemperatureControlMode {
  return modes[deviceId] ?? (legacyDisabled[deviceId] === true ? 'external' : 'mode');
}

export function temperatureControlDisabledDevices(
  modes: TemperatureControlModes,
  legacyDisabled: Record<string, boolean>,
): Record<string, boolean> {
  const ids = new Set([...Object.keys(legacyDisabled), ...Object.keys(modes)]);
  return Object.fromEntries([...ids].map((id) => [
    id, resolveTemperatureControlMode(modes, legacyDisabled, id) === 'external',
  ]));
}

/** Apply the independent runtime gates for price deltas and solar adjustments. */
export function temperaturePolicyPriceSettings<T extends { enabled: boolean; surplusWilling: boolean }>(
  settings: Record<string, T>,
  allowsPriceDeltas: (deviceId: string) => boolean,
  allowsSolarAdjustments: (deviceId: string) => boolean,
): Record<string, T> {
  return Object.fromEntries(Object.entries(settings).map(([id, config]) => [
    id, {
      ...config,
      enabled: allowsPriceDeltas(id) && config.enabled,
      surplusWilling: allowsSolarAdjustments(id) && config.surplusWilling,
    },
  ]));
}
