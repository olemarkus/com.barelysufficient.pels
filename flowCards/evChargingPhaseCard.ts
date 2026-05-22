import { createEvTargetPowerConfig, isEvTargetPowerPreset } from '../packages/shared-domain/src/evTargetPowerConfig';
import { DEVICE_TARGET_POWER_CONFIGS } from '../lib/utils/settingsKeys';
import { normalizeDeviceTargetPowerConfigs } from '../lib/utils/targetPowerConfig';
import type { TargetDeviceSnapshot, TargetPowerSteppedLoadPreset } from '../lib/utils/types';
import type { FlowCardDeps } from './registerFlowCards';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import {
  readFlowDeviceArg,
  readFlowStringArg,
} from './flowArgParsers';

const CARD_ID = 'set_ev_charging_phase';
const ELIGIBILITY_ERROR = 'Configure EV phase control for this charger in settings first.';

export function registerEvChargingPhaseCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard(CARD_ID);
  card.registerRunListener(async (args: unknown) => {
    const deviceId = readFlowDeviceArg(args, 'charger');
    const preset = readPhasePreset(args);
    const snapshot = await deps.getSnapshot();
    const device = snapshot.find((entry) => entry.id === deviceId);
    if (!deviceId || !device || !isEvPhaseConfiguredDevice(device)) {
      throw new Error(ELIGIBILITY_ERROR);
    }

    const existing = normalizeDeviceTargetPowerConfigs(deps.homey.settings.get(DEVICE_TARGET_POWER_CONFIGS));
    deps.homey.settings.set(DEVICE_TARGET_POWER_CONFIGS, {
      ...existing,
      [deviceId]: createEvTargetPowerConfig(preset),
    });
    deps.structuredLog?.info({
      event: 'ev_charging_phase_set_from_flow',
      sourceCardId: CARD_ID,
      deviceId,
      deviceName: device.name,
      preset,
      phase: formatPhaseForLog(preset),
    });
    return true;
  });
  card.registerArgumentAutocompleteListener('charger', async (query: string) => {
    const snapshot = await deps.getSnapshot();
    return buildDeviceAutocompleteOptions(snapshot.filter(isEvPhaseConfiguredDevice), query);
  });
}

function readPhasePreset(args: unknown): TargetPowerSteppedLoadPreset {
  const value = readFlowStringArg(args, 'phase');
  if (isEvTargetPowerPreset(value)) return value;
  throw new Error('EV charging phase must be 1-phase or 3-phase.');
}

function isEvPhaseConfiguredDevice(device: TargetDeviceSnapshot): boolean {
  return device.targetPowerConfig?.enabled !== false
    && isEvTargetPowerPreset(device.targetPowerConfig?.preset);
}

function formatPhaseForLog(preset: TargetPowerSteppedLoadPreset): string {
  return preset === 'ev_charger_1_phase' ? 'EV 1-phase' : 'EV 3-phase';
}
