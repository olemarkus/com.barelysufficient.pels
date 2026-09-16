import {
  SETTINGS_UI_DEVICES_PATH,
  type ChargerPhasePresets,
  type ChargerPhasePresetsRead,
} from '../../../contracts/src/settingsUiApi.ts';
import { isEvTargetPowerPreset } from '../../../shared-domain/src/evTargetPowerConfig.ts';
import { callApi } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { state } from './state.ts';

let trustedRead: ChargerPhasePresetsRead = { state: 'unavailable' };

// The map crosses the Homey API bridge untyped. A known charger with no entry
// reports no wiring, so the owner picks its control mode. One malformed entry
// makes the whole transport read unavailable; partially trusting it would
// erase last-good wiring for the affected charger.
const parseRead = (value: unknown): ChargerPhasePresetsRead => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { state: 'unavailable' };
  const read = value as Record<string, unknown>;
  if (read.state !== 'resolved' || typeof read.presets !== 'object' || read.presets === null
    || Array.isArray(read.presets)) return { state: 'unavailable' };
  const presets: Record<string, ChargerPhasePresets[string]> = {};
  for (const [deviceId, preset] of Object.entries(read.presets)) {
    if (!isEvTargetPowerPreset(preset)) return { state: 'unavailable' };
    presets[deviceId] = preset;
  }
  return { state: 'resolved', presets };
};

/**
 * Resolve one untrusted bridge value and retain the last complete map.
 * Callers beyond this adapter see either a concrete map or a semantic
 * unavailable result; raw `unknown` never reaches control-mode logic.
 */
export const applyChargerPhasePresetsRead = (value: unknown): ChargerPhasePresetsRead => {
  const nextRead = parseRead(value);
  if (nextRead.state === 'resolved') {
    trustedRead = nextRead;
    state.chargerPhasePresets = nextRead.presets;
  }
  return trustedRead;
};

/**
 * Retry the boundary read only when this WebView has never received a trusted
 * map. This makes Managed opt-in fail closed on a cold transient rather than
 * treating fabricated `{}` as a real "charger reported no wiring" answer.
 */
export const ensureChargerPhasePresetsRead = async (): Promise<ChargerPhasePresetsRead> => {
  if (trustedRead.state === 'resolved') return trustedRead;
  try {
    const payload = await callApi<unknown>('GET', SETTINGS_UI_DEVICES_PATH);
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return trustedRead;
    return applyChargerPhasePresetsRead((payload as Record<string, unknown>).chargerPhasePresets);
  } catch (error) {
    await logSettingsError('Failed to read charger wiring', error, 'device control');
    return trustedRead;
  }
};
