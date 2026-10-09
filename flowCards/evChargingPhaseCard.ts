import { createEvTargetPowerConfig, isEvTargetPowerPreset } from '../packages/shared-domain/src/evTargetPowerConfig';
import { writeDeviceTargetPowerConfig } from '../lib/device/deviceSettingMaps';
import type {
  DeviceDescriptorRead,
  TargetPowerSteppedLoadPreset,
} from '../packages/contracts/src/types';
import type { FlowCardDeps } from './registerFlowCards';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import {
  readFlowDeviceArg,
  readFlowStringArg,
} from './flowArgParsers';
import { getLogger } from '../lib/logging/logger';

const moduleLogger = getLogger('flowcards/ev-charging-phase');

const CARD_ID = 'set_ev_charging_phase';
const ELIGIBILITY_ERROR = 'Configure EV phase control for this charger in settings first.';

export function registerEvChargingPhaseCard(deps: FlowCardDeps): void {
  const card = deps.homey.flow.getActionCard(CARD_ID);
  card.registerRunListener(async (args: unknown) => {
    const deviceId = readFlowDeviceArg(args, 'charger');
    const preset = readPhasePreset(args);
    const descriptors = await deps.getDeviceDescriptors();
    const device = descriptors.find((entry) => entry.id === deviceId);
    if (!deviceId || !device || !isEvPhaseConfiguredDevice(device)) {
      throw new Error(ELIGIBILITY_ERROR);
    }

    // Every device's config lives in one map. A map that could not be read is
    // never saved over: the save would erase every other device's config.
    const outcome = writeDeviceTargetPowerConfig(deps.homey.settings, deviceId, createEvTargetPowerConfig(preset));
    if (outcome === 'unavailable') {
      moduleLogger.warn({
        event: 'ev_charging_phase_set_failed',
        reasonCode: 'setting_unreadable',
        sourceCardId: CARD_ID,
        deviceId,
        deviceName: device.name,
        preset,
      });
      throw new Error('PELS could not save the EV charging phase. Try again shortly.');
    }
    (deps.structuredLog ?? moduleLogger).info({
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
    // A phase preset is CONFIG: which devices can take one, and what one is set
    // to. Nothing here asks what the charger is doing.
    const descriptors = await deps.getDeviceDescriptors();
    return buildDeviceAutocompleteOptions(descriptors.filter(isEvPhaseConfiguredDevice), query);
  });
}

function readPhasePreset(args: unknown): TargetPowerSteppedLoadPreset {
  const value = readFlowStringArg(args, 'phase');
  if (isEvTargetPowerPreset(value)) return value;
  throw new Error('EV charging phase must be 1-phase or 3-phase.');
}

function isEvPhaseConfiguredDevice(device: DeviceDescriptorRead): boolean {
  // `targetPowerConfig` rides the stepped-descriptor probe but is read on its own
  // here (a continuous EV preset can carry it without a full stepped profile), so
  // this is an owner-probe read, not an `isSteppedLoadSnapshot` narrow.
  const config = device.targetPowerConfig;
  return Boolean(config) && config?.enabled !== false && isEvTargetPowerPreset(config?.preset);
}

function formatPhaseForLog(preset: TargetPowerSteppedLoadPreset): string {
  return preset === 'ev_charger_1_phase' ? 'EV 1-phase' : 'EV 3-phase';
}
